use std::io;
use std::os::fd::RawFd;
use std::path::Path;

use nix::libc;

use crate::{process_instance, process_snapshot};

fn socket_peer_pid(fd: RawFd) -> io::Result<u32> {
    let mut pid: libc::pid_t = 0;
    let mut size = size_of::<libc::pid_t>() as libc::socklen_t;
    // The kernel validates the inherited descriptor and writes into the two local variables.
    let status = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            std::ptr::from_mut(&mut pid).cast(),
            &mut size,
        )
    };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    if size as usize != size_of::<libc::pid_t>() || pid <= 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid Unix socket peer",
        ));
    }
    Ok(pid as u32)
}

/// A Desktop MCP client must be a direct child of stock Codex under the pinned Host.
pub fn authorize_macos_mcp_peer(
    fd: RawFd,
    host_pid: u32,
    host_start: u64,
    codex: &Path,
    node: &Path,
) -> bool {
    let Some(host) = process_instance(host_pid, host_start) else {
        return false;
    };
    let Ok(peer) =
        socket_peer_pid(fd).and_then(|pid| process_snapshot(pid).map_err(io::Error::other))
    else {
        return false;
    };
    let Ok(parent) = process_snapshot(peer.parent_id) else {
        return false;
    };
    peer.executable == node
        && parent.executable == codex
        && parent.parent_id == host.id
        && host.started_at_micros <= parent.started_at_micros
        && parent.started_at_micros <= peer.started_at_micros
        && process_instance(host_pid, host_start).is_some()
}

#[cfg(test)]
mod tests {
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;

    use super::*;
    use crate::process_identity;

    #[test]
    fn authenticates_the_kernel_peer_against_the_pinned_process_chain() {
        let (server, _client) = UnixStream::pair().unwrap();
        let fd = server.as_raw_fd();
        let pid = std::process::id();
        let peer = process_snapshot(pid).unwrap();
        let parent = process_snapshot(peer.parent_id).unwrap();
        let host = process_identity(parent.parent_id).unwrap();
        assert_eq!(socket_peer_pid(fd).unwrap(), pid);
        assert!(authorize_macos_mcp_peer(
            fd,
            host.id,
            host.started_at_micros,
            &parent.executable,
            &peer.executable,
        ));
        assert!(!authorize_macos_mcp_peer(
            fd,
            host.id,
            host.started_at_micros + 1,
            &parent.executable,
            &peer.executable,
        ));
        assert!(!authorize_macos_mcp_peer(
            fd,
            host.id,
            host.started_at_micros,
            Path::new("/unexpected/codex"),
            &peer.executable,
        ));
    }
}
