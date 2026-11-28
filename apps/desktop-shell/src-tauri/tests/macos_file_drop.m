#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

void codexhost_install_file_drop(void *webview, const char *stage);

// Wry owns an override on its WKWebView subclass and delegates HTML drops to super.
@interface ShellView : WKWebView
@property BOOL deliver;
@property(nonatomic, strong) NSPasteboard *received;
@end
@implementation ShellView
- (BOOL)performDragOperation:(id<NSDraggingInfo>)sender {
    self.received = sender.draggingPasteboard;
    return self.deliver ? [super performDragOperation:sender] : YES;
}
@end

// Only the drag source is synthetic. AppKit supplies the pasteboard and WebKit reads the Files.
@interface Drag : NSObject
@property(nonatomic, strong) NSWindow *draggingDestinationWindow;
@property(nonatomic, strong) NSPasteboard *draggingPasteboard;
@property(nonatomic, weak) id draggingSource;
@property NSInteger numberOfValidItemsForDrop;
@property NSDraggingFormation draggingFormation;
@end
@implementation Drag
- (NSPoint)draggingLocation { return NSMakePoint(50, 50); }
- (NSInteger)draggingSequenceNumber { return 1; }
- (NSDragOperation)draggingSourceOperationMask { return NSDragOperationCopy; }
- (void)enumerateDraggingItemsWithOptions:(NSDraggingItemEnumerationOptions)options forView:(NSView *)view
    classes:(NSArray<Class> *)classes searchOptions:(NSDictionary *)searchOptions
    usingBlock:(void (^)(NSDraggingItem *, NSInteger, BOOL *))block {
    BOOL stop = NO;
    NSInteger index = 0;
    for (id item in [self.draggingPasteboard readObjectsForClasses:classes options:searchOptions]) {
        block([[NSDraggingItem alloc] initWithPasteboardWriter:item], index++, &stop);
        if (stop) break;
    }
}
@end

@interface Messages : NSObject<WKScriptMessageHandler>
@property(nonatomic, strong) id value;
@end
@implementation Messages
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    self.value = message.body;
}
@end

static void pump(NSTimeInterval seconds) {
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:seconds]];
}

static void expect(Messages *messages, id expected) {
    NSDate *limit = [NSDate dateWithTimeIntervalSinceNow:15];
    while (!messages.value && limit.timeIntervalSinceNow > 0) pump(0.01);
    NSCAssert([messages.value isEqual:expected], @"Expected %@, got %@", expected, messages.value);
    messages.value = nil;
}

static int verifyDrop(void) API_AVAILABLE(macos(12.0));
static int verifyDrop(void) {
    @autoreleasepool {
        NSString *home = NSHomeDirectory();
        NSCAssert([home.lastPathComponent hasPrefix:@"codexhost-drop-test-"], @"Requires an isolated HOME");
        NSFileManager *fs = NSFileManager.defaultManager;
        NSURL *base = [NSURL fileURLWithPath:home isDirectory:YES];
        NSURL *stage = [base URLByAppendingPathComponent:@"stage"];
        NSCAssert([fs createDirectoryAtURL:stage withIntermediateDirectories:YES attributes:nil error:nil], @"stage");
        NSMutableArray *files = [NSMutableArray array];
        for (NSString *name in @[@"first", @"second"]) {
            NSString *path = [@"Library/Containers/org.example.drop/Data" stringByAppendingPathComponent:name];
            NSURL *dir = [base URLByAppendingPathComponent:path];
            NSCAssert([fs createDirectoryAtURL:dir withIntermediateDirectories:YES attributes:nil error:nil], @"source");
            NSURL *file = [dir URLByAppendingPathComponent:@"clip.mp4"];
            NSCAssert([name writeToURL:file atomically:YES encoding:NSUTF8StringEncoding error:nil], @"write");
            [files addObject:file];
        }

        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        WKWebViewConfiguration *config = [WKWebViewConfiguration new];
        config.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
        Messages *messages = [Messages new];
        [config.userContentController addScriptMessageHandler:messages name:@"result"];
        NSRect frame = NSMakeRect(0, 0, 200, 200);
        ShellView *view = [[ShellView alloc] initWithFrame:frame configuration:config];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:frame styleMask:NSWindowStyleMaskBorderless
                                                        backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed = NO;
        window.contentView = view;
        Class observedClass = object_getClass(view);
        codexhost_install_file_drop((__bridge void *)view, stage.fileSystemRepresentation);
        NSCAssert(object_getClass(view) == observedClass, @"preserve AppKit's KVO subclass");
        NSURLRequest *request = [NSURLRequest requestWithURL:[NSURL URLWithString:@"http://127.0.0.1/"]];
        [view loadSimulatedRequest:request responseHTMLString:
            @"<body style='height:100vh'><script>const report=x=>webkit.messageHandlers.result.postMessage(x);"
             "ondragover=e=>e.preventDefault();ondrop=e=>{e.preventDefault();window.dropped=[...e.dataTransfer.files]};"
             "report('ready')</script>"];
        expect(messages, @"ready");

        Drag *drag = [Drag new];
        drag.draggingDestinationWindow = window;
        NSPasteboard *board = [NSPasteboard pasteboardWithUniqueName];
        NSCAssert([board writeObjects:files], @"pasteboard");
        drag.draggingPasteboard = board;
        id<NSDraggingInfo> info = (id)drag;
        ShellView *sibling = [[ShellView alloc] initWithFrame:frame configuration:config];
        NSCAssert([sibling performDragOperation:info] && sibling.received == board, @"uninstalled view");
        drag.draggingSource = view;
        NSCAssert([view performDragOperation:info] && view.received == board, @"internal drag");
        drag.draggingSource = nil;
        NSPasteboard *mixed = [NSPasteboard pasteboardWithUniqueName];
        NSPasteboardItem *item = [NSPasteboardItem new];
        [item setString:[files.firstObject absoluteString] forType:NSPasteboardTypeFileURL];
        [item setString:@"<b>label</b>" forType:NSPasteboardTypeHTML];
        NSCAssert([mixed writeObjects:@[item]], @"mixed pasteboard");
        drag.draggingPasteboard = mixed;
        NSCAssert([view performDragOperation:info] && view.received == mixed, @"preserve alternate representation");
        [mixed releaseGlobally];

        drag.draggingPasteboard = board;
        view.deliver = YES;
        [view draggingEntered:info];
        NSDate *limit = [NSDate dateWithTimeIntervalSinceNow:5];
        while ([view draggingUpdated:info] == NSDragOperationNone && limit.timeIntervalSinceNow > 0) pump(0.02);
        NSCAssert([view prepareForDragOperation:info] && [view performDragOperation:info], @"external drop");
        for (NSURL *file in files) NSCAssert([fs removeItemAtURL:file error:nil], @"withdraw original");
        [view evaluateJavaScript:
            @"(async()=>{while(!window.dropped)await new Promise(r=>setTimeout(r,10));"
             "report(await Promise.all(dropped.map(async f=>f.name+':'+await f.text())))})().catch(e=>report(String(e)))"
            completionHandler:nil];
        expect(messages, (@[@"clip.mp4:first", @"clip.mp4:second"]));
        [view concludeDragOperation:info];
        [board releaseGlobally];
        window.contentView = nil;
        [window close];
    }
    return 0;
}

int main(void) {
    if (@available(macOS 12.0, *)) return verifyDrop();
    fprintf(stderr, "Skipping native drop fixture: simulated WK requests require macOS 12.\n");
    return 0;
}
