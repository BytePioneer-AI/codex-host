# CodexHost Privacy Policy

## About CodexHost

CodexHost is an independent, unofficial open-source project. It is not affiliated with or endorsed by OpenAI. It integrates external Agent Harnesses into Codex Desktop and supports remote use through SSH and official Codex Desktop Remote Control.

## Local data and Harness integrations

CodexHost stores its own application data locally on the machine running the Host. It does not provide a CodexHost-hosted cloud conversation storage service. Native session history is generally maintained in each Harness's own storage; some CodexHost Adapters also keep local history for integration compatibility.

CodexHost connects the Desktop interface to your selected Harness, forwarding prompts, generated output, tool status, approvals, and diffs as needed to run and display tasks. Model requests and tool access follow that Harness's configuration and permissions, using your selected services, such as OpenAI, Anthropic, xAI, or other Providers. These services manage their own data under their respective policies; CodexHost does not operate their storage or set their retention rules.

If you use remote features, task content travels between your computers through SSH or official Codex Desktop Remote Control. The controlled host runs the tasks, while the authorized controller can submit instructions, view results, and respond to approvals. Official Remote Control manages pairing and relay transport; CodexHost does not operate a separate relay.

Account features may query the corresponding service for identity and usage information. Installation and updates use GitHub or your configured package registry. These services receive the connection and request information needed to provide those functions.

## Credentials

Authentication generally uses the selected application's existing credentials and storage. CodexHost backend integrations may read or use credentials for supported account features. Remote connections do not automatically copy Harness credential stores between computers.

With your confirmation, supported Codex or Grok credentials can be copied into Pi's own storage on the same Host. Removing that import does not sign out the source account or revoke service-side authorization. Already running sessions may retain credentials until closed.

## Storage and deletion

CodexHost stores settings, session mappings, diagnostic logs, and some Adapter-maintained conversation history locally. The default Host data directory is `~/.codexhost`, or the directory configured through `CODEXHOST_DATA_DIR`; managed SSH installations normally use `~/.codexhost/remote/data`. Harnesses and Codex Desktop also maintain their own storage.

Host Runtime logs are stored locally and are not automatically uploaded by the logger. They are rotated and cleaned up on a best-effort basis; other stored data has no universal expiration period.

After stopping CodexHost, you can delete its applicable local data. Native Harness history and credentials are managed separately through the corresponding application; service-side data and authorization are managed through the service provider. Archiving or uninstalling does not necessarily erase stored data, and deleting CodexHost's local files does not delete those separately managed records. Remote access can be revoked through official Remote Control or your SSH configuration.

## Contact

For non-sensitive privacy questions, open an issue at [BytePioneer-AI/codex-host](https://github.com/BytePioneer-AI/codex-host/issues). Do not include credentials, private code, or unredacted logs in public reports.
