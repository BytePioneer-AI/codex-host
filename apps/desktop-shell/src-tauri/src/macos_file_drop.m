// AppKit may grant the shell access to a dropped file in another app's container
// without allowing WebKit's network process to read that same file.
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/clonefile.h>
#include <sys/stat.h>
#include <unistd.h>

typedef BOOL (*DropHandler)(id, SEL, id<NSDraggingInfo>);

@interface CHDropState : NSObject
@property(nonatomic, strong) NSURL *stage;
@property(nonatomic, strong) NSMutableArray<NSPasteboard *> *boards;
@end

@implementation CHDropState
- (void)dealloc {
    for (NSPasteboard *board in _boards) [board releaseGlobally];
}
@end

// Keep AppKit's location, operation mask and drag identity. Only the file
// representations change. WebKit may read the named pasteboard asynchronously.
@interface CHDropInfo : NSProxy {
    id<NSDraggingInfo> _sender;
    NSPasteboard *_board;
}
- (instancetype)initWithSender:(id<NSDraggingInfo>)sender board:(NSPasteboard *)board;
@end

@implementation CHDropInfo
- (instancetype)initWithSender:(id<NSDraggingInfo>)sender board:(NSPasteboard *)board {
    _sender = sender;
    _board = board;
    return self;
}
- (NSPasteboard *)draggingPasteboard { return _board; }
- (NSMethodSignature *)methodSignatureForSelector:(SEL)sel {
    return [(NSObject *)_sender methodSignatureForSelector:sel];
}
- (void)forwardInvocation:(NSInvocation *)invocation {
    [invocation invokeWithTarget:_sender];
}
@end

static char stateKey;
static DropHandler originalDrop;
static Class hookedClass;

static BOOL inAppContainer(NSString *path) {
    NSString *library = [NSHomeDirectory() stringByAppendingPathComponent:@"Library"];
    return [path hasPrefix:[library stringByAppendingString:@"/Containers/"]] ||
           [path hasPrefix:[library stringByAppendingString:@"/Group Containers/"]];
}

static BOOL copyOpenedFile(int source, NSURL *destination, const struct stat *before) {
    // Container data and the shell's temporary directory are normally on APFS.
    if (fclonefileat(source, AT_FDCWD, destination.fileSystemRepresentation, CLONE_NOOWNERCOPY) == 0)
        return YES;

    if (before->st_size < 0) return NO;
    int fd = open(destination.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (fd < 0) return NO;
    uint8_t buffer[64 * 1024];
    off_t copied = 0;
    // Bound memory and copy exactly the observed size if the source volume cannot clone.
    while (copied < before->st_size) {
        size_t length = (size_t)MIN(before->st_size - copied, (off_t)sizeof(buffer));
        ssize_t count = pread(source, buffer, length, copied);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) break;
        ssize_t written = pwrite(fd, buffer, (size_t)count, copied);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) break;
        copied += written;
    }
    BOOL closed = close(fd) == 0;
    struct stat after;
    return closed && copied == before->st_size && fstat(source, &after) == 0 && after.st_size == before->st_size &&
        after.st_mtimespec.tv_sec == before->st_mtimespec.tv_sec &&
        after.st_mtimespec.tv_nsec == before->st_mtimespec.tv_nsec;
}

static NSURL *stageFile(NSURL *url, NSURL *batch) {
    if ([url.path.pathComponents containsObject:@".."] || [url.path.pathComponents containsObject:@"."])
        return nil;
    BOOL scoped = [url startAccessingSecurityScopedResource];
    int fd = open(url.fileSystemRepresentation, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW_ANY);
    NSURL *staged = nil;
    if (fd >= 0) {
        struct stat info;
        if (fstat(fd, &info) == 0 && S_ISREG(info.st_mode)) {
            NSURL *dir = [batch URLByAppendingPathComponent:NSUUID.UUID.UUIDString isDirectory:YES];
            NSURL *dest = [dir URLByAppendingPathComponent:url.lastPathComponent isDirectory:NO];
            if ([NSFileManager.defaultManager createDirectoryAtURL:dir withIntermediateDirectories:NO
                attributes:@{NSFilePosixPermissions: @0700} error:nil] &&
                copyOpenedFile(fd, dest, &info) && chmod(dest.fileSystemRepresentation, 0400) == 0)
                staged = dest;
        }
        close(fd);
    }
    if (scoped) [url stopAccessingSecurityScopedResource];
    return staged;
}

static BOOL performDrop(WKWebView *view, SEL selector, id<NSDraggingInfo> sender) {
    CHDropState *state = objc_getAssociatedObject(view, &stateKey);
    NSString *scheme = view.URL.scheme;
    if (!state || sender.draggingSource || !([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"]))
        return originalDrop(view, selector, sender);

    NSPasteboard *source = sender.draggingPasteboard;
    NSArray<NSPasteboardItem *> *items = source.pasteboardItems;
    // Rebuilding an URL-only pasteboard would discard rich text, image or promise alternatives.
    for (NSPasteboardItem *item in items) {
        if (![item.types containsObject:NSPasteboardTypeFileURL] ||
            [item.types containsObject:NSPasteboardTypeString] ||
            [item.types containsObject:NSPasteboardTypeHTML] ||
            [item.types containsObject:NSPasteboardTypeRTF] ||
            [item.types containsObject:NSPasteboardTypeRTFD] ||
            [item.types containsObject:NSPasteboardTypePNG] ||
            [item.types containsObject:NSPasteboardTypeTIFF] ||
            [item.types containsObject:@"com.apple.pasteboard.promised-file-url"] ||
            [item.types containsObject:@"NSFilesPromisePboardType"])
            return originalDrop(view, selector, sender);
    }
    NSArray<NSURL *> *urls = [source readObjectsForClasses:@[NSURL.class]
        options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}];
    if (!urls.count || items.count != urls.count) return originalDrop(view, selector, sender);

    for (NSURL *url in urls) {
        if (!url.isFileURL || (url.host.length && ![url.host.lowercaseString isEqualToString:@"localhost"]) ||
            [url.path rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound)
            return originalDrop(view, selector, sender);
    }

    NSMutableArray<NSURL *> *files = [NSMutableArray arrayWithCapacity:urls.count];
    NSURL *batch = nil;
    for (NSURL *url in urls) {
        if (!inAppContainer(url.path)) {
            [files addObject:url];
            continue;
        }
        if (!batch) {
            batch = [state.stage URLByAppendingPathComponent:NSUUID.UUID.UUIDString isDirectory:YES];
            if (![NSFileManager.defaultManager createDirectoryAtURL:batch withIntermediateDirectories:NO
                attributes:@{NSFilePosixPermissions: @0700} error:nil])
                return originalDrop(view, selector, sender);
        }
        NSURL *copy = stageFile(url, batch);
        if (!copy) break;
        [files addObject:copy];
    }
    if (!batch) return originalDrop(view, selector, sender);
    if (files.count == urls.count) {
        NSPasteboard *board = [NSPasteboard pasteboardWithUniqueName];
        if ([board writeObjects:files]) {
            CHDropInfo *info = [[CHDropInfo alloc] initWithSender:sender board:board];
            if (originalDrop(view, selector, (id<NSDraggingInfo>)info)) {
                [state.boards addObject:board];
                return YES;
            }
            [board releaseGlobally];
            [NSFileManager.defaultManager removeItemAtURL:batch error:nil];
            return NO;
        }
        [board releaseGlobally];
    }
    [NSFileManager.defaultManager removeItemAtURL:batch error:nil];
    return originalDrop(view, selector, sender);
}

// The caller supplies Wry's app-owned WKWebView subclass. Change only its own
// override, leaving WebKit's class and the instance's KVO isa untouched.
void codexhost_install_file_drop(void *wkview, const char *stage_dir) {
    WKWebView *view = (__bridge WKWebView *)wkview;
    if (!view || !stage_dir || !NSThread.isMainThread || objc_getAssociatedObject(view, &stateKey)) return;
    Class owned = view.class;
    SEL selector = @selector(performDragOperation:);
    if (class_getSuperclass(owned) != WKWebView.class) return;
    Method method = class_getInstanceMethod(owned, selector);
    if (!method || method == class_getInstanceMethod(WKWebView.class, selector)) return;
    if (!hookedClass) {
        originalDrop = (DropHandler)method_setImplementation(method, (IMP)performDrop);
        hookedClass = owned;
    }
    if (owned != hookedClass) return;
    CHDropState *state = [CHDropState new];
    state.stage = [NSURL fileURLWithFileSystemRepresentation:stage_dir isDirectory:YES relativeToURL:nil];
    state.boards = [NSMutableArray array];
    objc_setAssociatedObject(view, &stateKey, state, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}
