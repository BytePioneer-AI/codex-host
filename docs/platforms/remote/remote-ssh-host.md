# Use AI coding tools on a remote computer over SSH

The Web console’s **Remote connections** page (`#remote-connections`) provides the same connection management, installation, update, repair, and uninstall actions as the embedded settings. Codex Desktop must be running through codexhost on the local computer.

Use Claude Code, Pi, and other Harnesses (AI coding tools) installed and signed in on another computer from your local Codex Desktop. Your project and tools run remotely while you read replies, send messages, and manage the conversation locally.

## Before you start

- **Local computer**: install Codex Desktop and codexhost, and make sure you can open **Settings → Connections → SSH** in Codex.
- **Remote computer**: use a Mac or Linux computer with SSH enabled and Node.js, npm, and Codex CLI installed. Windows remote computers are not currently supported.
- **Your coding tool**: install it and sign in on the remote computer—for example, Claude Code.
- **Connection details**: have the SSH address ready, such as `username@computer-address`. If your connection needs a specific port or identity file, have those details ready too.

Update local codexhost to the latest version before installing the remote end below.

## Step 1: Check SSH login

Log in to the remote computer once through SSH from your local terminal and confirm its identity. The page uses your existing SSH key or alias and does not show a password prompt.

The remote computer needs Node.js, npm and Codex CLI, with permission for your user to install npm packages. Use Node.js 22.19 or later in the 22.x series, or Node.js 24.x. Installation loads your interactive login shell, including configured version managers such as nvm. Existing installations prefer the executable Node.js path recorded by codexhost; an unsupported recorded version must be updated before maintenance. On a remote Mac, keep the desktop user logged in when using Claude Code.

## Step 2: Add an SSH connection

1. Launch Codex Desktop through codexhost on your local computer.
2. Open **codexhost settings → Remote connections** and click **Add connection**.
3. Enter the connection details:
   - **Name**: choose a recognizable name, such as “Office computer.”
   - **SSH address**: enter `username@computer-address` or an existing SSH alias.
   - **Port and identity file**: fill these in only if your connection requires them; otherwise, leave them blank.
4. Click **Save**. The page checks the computer. Choose **Install and connect** if the remote service is missing, or **Connect** if it is already installed.
   - Wait for the installation result; you do not need to copy installation commands.
   - Installation uses the published stable version running locally. Development builds require a stable runtime version as described in **Test from source with a specified version** below.
5. Once it shows **Connected**, open a project on that computer in Codex.

Existing Codex SSH connections appear here automatically; you do not need to add them again. Both pages share the same connection settings, so changes appear in both places.

For connections discovered from your SSH config, you can edit the name here. Edit other details in your local SSH config, or view them in Codex **Settings → Connections → SSH**.

## Step 3: Choose a tool and start working

In the remote project's composer, choose your Harness and model from the **Agent / Model** selector, then send a message as usual.

You can work in local and remote projects at the same time. Each shows the tools and models available on its own computer.

If you only use Codex's built-in remote coding features, you do not need codexhost on the remote computer.

### Image and file attachments

External Harnesses continue to receive text and file paths, not Harness-specific image inputs. Ordinary files use Desktop's native upload and remote path references. Reading files, interpreting images, and parsing their formats depend on the Harness's tools and the selected model.

For ordinary submissions to remote external Threads (including automatic submission from Desktop's local queue), if Desktop supplies inline images without a complete set of image paths in the message, codexhost uses **that same remote connection's native attachment store**, waits for successful storage, then adds remote paths to the text. Complete native image references are reused without another upload. Local Threads and native Codex Threads are unchanged; changing direction retains its existing rejection of non-text input.

Fallback storage uses Desktop's `$CODEX_HOME/attachments/` directory and native management, not a separate SSH transfer channel or Host attachment database. When native paths are only partially available, their correspondence to individual inline images is ambiguous, so all inline images are stored rather than guessing which is missing. Fallback storage allows up to 20 images, 20 MiB per image and 32 MiB total (decoded image data). Invalid data, an unavailable native storage interface, upload failure or replacement of the connection prevents submission. Files are retained when a dispatched Turn's outcome is unknown; the message is not automatically retried.

This binding follows the attachment storage and request interfaces in Desktop 26.930.31730 and requires compatibility review after Desktop updates.

## Manage connections

Use **Remote connections** to edit connection details, disconnect, or remove a connection you no longer use.

- **Disconnect** stops automatic connection to that computer. Tasks already started remotely can continue. Click **Connect** when you want to use it again.
- **Remove** removes the computer from the connection list without deleting remote files or conversations.

## Update the remote end

The Remote connections page shows the local version and the remote **Installed** and **Running** versions. **Running** is the version currently in use. If the page asks you to restart, follow its prompt.

Each computer shows its own available actions. Operations run only when you click:

- **Install and connect** installs the remote service, then connects.
- **Match local version** appears for older remote versions. Click to update and restart immediately.
- **Update remote service** appears when the remote end is too old to report its version. Click to install the local version over SSH, then reconfigure and start the remote service.
- **Restart and connect** appears when a newer build is installed but an older build is running. Click to restart immediately.
- **Reconnect** appears when a connection fails. It disconnects and connects again right away.
- **Repair remote service** appears only when remote status is unavailable, the connection failed, or an update failed. It stops the service, removes its connection setup, configures it again and starts it. It does not uninstall or update the codexhost package.
- **Check again** retries an unavailable remote status. A failed check does not mean the service is missing.

Updates, restarts and repairs run immediately and may interrupt active conversations. There is no task-completion wait.

The page does not install or update in the background. These actions update codexhost software, not project files or conversation history.

If the remote version is newer, update the local computer first. Reconnect if the connection does not recover after an update.

### When you need to update manually

Older remote installations cannot report their version; the page shows **Update remote service**, which is usually all you need. If the button is unavailable (the local build is not a published release) or the update fails:

1. Update local codexhost to the latest version.
2. Run these commands in order in a terminal on the remote computer:

```bash
codexhost remote stop
npm install -g @codexhost/cli@latest
codexhost remote install
codexhost remote start
```

Then reconnect to that computer from your local machine.

## Test from source with a specified version

From the repository root, run:

```bash
npm start 0.12.0
```

This sets the source runtime version for the whole launch: Host status, the console and update-check version reporting share this value. Remote installation and updates use that same version through the normal version policy. The remote npm package must already be published; this command does not upload local changes. Without a version argument, the source version remains `<workspace-version>-dev` and npm installation stays disabled. The override does not change version files or turn the source checkout into an installed distribution with self-update resources.

To test unpublished remote Host or Broker changes too, build and install the corresponding remote platform package on that computer; changing the local version label cannot deliver those changes.

## View the same conversation on both computers

If the remote computer also has Codex Desktop, launch it through codexhost there. Use the same codexhost version on both computers, and use the same user account for the remote desktop login and SSH connection.

External Harness conversations created in an SSH project appear on the other computer automatically. This may take a few seconds initially. Both computers can show messages, replies as they arrive, and tool activity. You can also send messages, interrupt tasks, or answer approvals from either computer.

Keep these points in mind:

- Use the insert-message feature to add input during a running task. Starting a separate task may return a busy message.
- If both computers answer the same approval or question, the first processed answer applies.
- After disconnecting, reopen the conversation to see what happened while you were away. If you are unsure whether a message was sent, check the conversation before resending it.

This applies to external Harness conversations created in SSH projects. Other local conversations and built-in Codex conversations continue to work as before.

## Troubleshooting

| What happened | What to try |
| --- | --- |
| A specific tool (Node.js, npm or Codex CLI) is not detected over SSH | Install the named tool on the remote computer, or add its existing installation to the login shell PATH, then retry. This message does not prove the tool is uninstalled. Codex CLI is the command-line tool; remote Codex Desktop is not required. |
| The connection fails or disconnects shortly afterward | Check that SSH login works, then choose **Check again**. If the service is missing, choose **Install and connect**. If needed, follow the manual update steps and reconnect. |
| A Harness is missing | Confirm the tool is installed and signed in on the remote computer, then click **Run connection diagnostics** on codexhost's **Connections** page. |
| Remote version information is missing or the service is outdated | Choose **Update remote service**. If it is unavailable or fails, follow **When you need to update manually** above. |
| An update fails | Check the remote computer's internet connection and retry. If it still fails, follow the manual update steps. |
| The other computer does not show the same conversation | Check that both computers launched Desktop through codexhost, use the same version, and use the same remote user account. If you use a custom data directory, use the same directory for both launch methods. |
| Installation fails on a Mac | Make sure the remote Mac's desktop user is logged in, then run `codexhost remote install` again. |

## Stop or uninstall

Choose **Uninstall remote service** on the connection card. After confirmation, auto-connect is disabled for this connection, the remote service stops and its connection setup is removed. On Mac, the associated Harness background service is also uninstalled. The SSH connection entry, project files and chat data are kept, so the service can be installed again later. Active remote sessions are interrupted.

The codexhost package is kept by default. Select **Also uninstall the codexhost package** to remove the remote computer's global npm `@codexhost/cli` after service removal succeeds. Codex CLI, Node.js and other Harnesses are kept. Only select this if the remote Desktop no longer needs that package to launch. A mismatch between the active CLI and npm's global installation rejects package removal before stopping the service; choose service-only removal or uninstall the package manually on the remote computer. If package removal fails after service removal, the page explains the partial result and allows retrying.

When you no longer need the remote installation, run these commands on the remote computer:

```bash
codexhost remote stop
codexhost remote uninstall
```

Stopping the service interrupts active conversations. To disconnect temporarily, use **Disconnect** on the page; you do not need to uninstall.
