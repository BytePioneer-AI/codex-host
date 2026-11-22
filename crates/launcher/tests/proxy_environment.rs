use std::process::Command;

fn command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_codexhost"));
    command.arg("proxy-environment");
    // Explicit empty values prevent the test machine's system proxy from filling them.
    for name in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
    ] {
        command.env(name, "");
    }
    command.env_remove("NODE_USE_ENV_PROXY");
    command
}

fn environment(command: &mut Command) -> serde_json::Value {
    let output = command.output().expect("run proxy environment resolver");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("proxy environment JSON")
}

#[test]
fn enables_node_proxy_support_using_the_shared_native_policy() {
    let env = environment(
        command()
            .env("HTTPS_PROXY", "http://127.0.0.1:12345")
            .env("https_proxy", "http://127.0.0.1:12345")
            .env("NO_PROXY", "example.test")
            .env("UNRELATED_CREDENTIAL", "must-not-be-exported"),
    );
    assert_eq!(env["HTTPS_PROXY"], "http://127.0.0.1:12345");
    assert_eq!(env["https_proxy"], "http://127.0.0.1:12345");
    assert_eq!(env["NODE_USE_ENV_PROXY"], "1");
    let bypass = env["NO_PROXY"].as_str().expect("bypass list");
    for host in ["example.test", "localhost", "127.0.0.1", "::1"] {
        assert!(bypass.split(',').any(|entry| entry == host));
    }
    assert_eq!(env["no_proxy"], env["NO_PROXY"]);
    assert!(env.get("UNRELATED_CREDENTIAL").is_none());
}

#[test]
fn leaves_explicitly_disabled_proxies_disabled() {
    let env = environment(&mut command());
    assert_eq!(env["HTTP_PROXY"], "");
    assert_eq!(env["HTTPS_PROXY"], "");
    assert_eq!(env["ALL_PROXY"], "");
    assert!(env.get("NODE_USE_ENV_PROXY").is_none());
}

#[test]
fn preserves_an_explicit_node_proxy_opt_out() {
    let env = environment(
        command()
            .env("HTTPS_PROXY", "http://127.0.0.1:12345")
            .env("NODE_USE_ENV_PROXY", "0"),
    );
    assert_eq!(env["NODE_USE_ENV_PROXY"], "0");
}

#[test]
fn rejects_unexpected_arguments() {
    let output = command().arg("unexpected").output().expect("run resolver");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}
