---
title: Overview
description: Choose between Web & Mobile access, SSH Remote Hosts, and Windows Remote Control.
---

# Overview

CodexHost offers three ways to work across devices, depending on **where your codebase and agents actually run**:

| Mode | Where you use the UI | Where agents run | Where code & credentials stay | Guide |
| :--- | :--- | :--- | :--- | :--- |
| **Local Desktop** | Local Codex Desktop | Your computer | Your computer | [Installation](/en/docs/quick-start/install) |
| **Web & Mobile** | Phone, tablet, or browser | **Main computer** (shared with Desktop) | **Main computer** | [Web & Mobile](/en/docs/web/mobile) |
| **SSH Host** | Local Codex Desktop | **Remote Linux / macOS server** | **Remote Linux / macOS server** | [SSH Host](/en/docs/remote/ssh) |
| **Remote Control** | Controller's Codex Desktop | **Target Windows PC** | **Target Windows PC** | [Remote Control](/en/docs/remote/remote-control) |

## Which one to use

- **Your code and agents run on your main computer, and you want to check or steer them from your phone or tablet**
  Use **[Web & Mobile](/en/docs/web/mobile)**. Scan a QR code to connect directly to your computer's Host.
- **You work on a laptop, while your repo, toolchain, and agent logins live on a remote Linux or macOS dev box**
  Use **[SSH Host](/en/docs/remote/ssh)**. Your local Codex Desktop renders the UI while agents run on the server.
- **Your code and agents live on a Windows PC, and you want to drive them from another computer without SSH or port forwarding**
  Use **[Remote Control](/en/docs/remote/remote-control)** with a pairing code.
