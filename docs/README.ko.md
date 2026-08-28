<div align="center">

# CodexHost

**Codex Desktop에서 Pi와 다른 Harness를 실행하세요**

저희는 **Codex Desktop**이 최고의 데스크톱 개발 경험 중 하나를 제공한다고 생각합니다.

하지만 **Codex**만이 뛰어난 **Agent Harness**인 것은 아닙니다. **Claude Code**나 **Pi Agent**를 선호하는 개발자도 있습니다.

**CodexHost**를 사용하면 **Codex Desktop**의 기본 경험을 유지하면서 실제 작업을 실행할 **Agent**를 선택할 수 있습니다.

⭐ 이 프로젝트가 도움이 되었다면 Star를 눌러 주세요! ⭐

<p>
  <a href="https://opensource.org/licenses/MIT"><img alt="MIT 라이선스" src="https://img.shields.io/badge/license-MIT-1f6feb?logo=open-source-initiative&logoColor=white" /></a>
  <a href="https://linux.do"><img alt="LINUX DO" src="https://shorturl.at/ggSqS" /></a>
</p>

<p>
  <a href="https://pi.dev/"><img alt="Pi" src="https://img.shields.io/badge/Pi-000000?logo=pi&logoColor=white" /></a>
  <a href="https://openai.com/codex/"><img alt="Codex" src="imgs/badge-codex.svg" /></a>
  <a href="https://code.claude.com/docs/en/quickstart"><img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-D97757?logo=claudecode&logoColor=white" /></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek-4D6BFE?logo=deepseek&logoColor=white" /></a>
  <a href="https://grok.com/"><img alt="Grok" src="https://img.shields.io/badge/Grok-000000?logo=x&logoColor=white" /></a>
  <a href="https://github.com/can1357/oh-my-pi"><img alt="Oh My Pi" src="imgs/badge-omp-v5.svg" /></a>
</p>

<p align="center">
  <sub><a href="../README.md">简体中文</a> · <a href="README.en.md">English</a> · 한국어</sub>
</p>
</div>

## 인터페이스 미리보기

앱을 전환하지 않고도 **Pi, Claude Code, OMP, Grok Build, DeepSeek Harness**를 하나의 Codex Desktop 창에서 바로 사용할 수 있습니다.

https://github.com/user-attachments/assets/c48192d7-23ff-4f6e-b61a-6345a655bb76

### 인터페이스

![Codex Desktop에서 독립 Thread로 실행 중인 Pi, Oh My Pi, Grok Build, DeepSeek Harness](imgs/codexhost-interface-overview.png)

## 기능 상태

| 기능 | <a href="https://openai.com/codex/"><img alt="Codex" src="imgs/badge-codex.svg" /></a> | <a href="https://pi.dev/"><img alt="Pi" src="https://img.shields.io/badge/Pi-000000?logo=pi&logoColor=white" /></a> | <a href="https://github.com/can1357/oh-my-pi"><img alt="Oh My Pi" src="imgs/badge-omp-v5.svg" /></a> | <a href="https://code.claude.com/docs/en/quickstart"><img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-D97757?logo=claudecode&logoColor=white" /></a> | <a href="https://grok.com/"><img alt="Grok" src="https://img.shields.io/badge/Grok-000000?logo=x&logoColor=white" /></a> | <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek-4D6BFE?logo=deepseek&logoColor=white" /></a> |
| --- | --- | --- | --- | --- | --- | --- |
| 스트리밍 응답 | 기본 제공 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 도구 상태 | 기본 제공 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edit Diff | 기본 제공 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 질문 / 취소 | 기본 제공 | ✅ | — / ✅ | ✅ | ✅ | ✅ |
| Model / Thinking 선택 | 기본 제공 | ✅ | ✅ | ✅ | ✅ | 🚧 |
| 도구 승인 | 기본 제공 | ✅ | — | ✅ | ✅ | ✅ |
| 권한 모드 | 기본 제공 | — | — | ✅ | ✅ | — |
| Usage | 기본 제공 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Fork | 기본 제공 | ✅ | ✅ | ✅ | ✅ | — |
| 컨텍스트 압축 | 기본 제공 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 슬래시 명령 | 기본 제공 | ✅ | ✅ | ✅ | ✅ | — |
| 이전 메시지 수정 | 기본 제공 | ✅ | ✅ | ✅ | ✅ | — |

## 빠른 시작

**npm 사용**

> macOS, Windows 및 [x64 Linux](linux.md)를 지원합니다.

```bash
npm install -g @codexhost/cli
codexhost
```

**또는** [설치 프로그램](https://github.com/BytePioneer-AI/codex-host/releases) 다운로드 (macOS, Windows)

<details>
<summary>설치 문제 해결</summary>

**macOS** - Apple 인증 문제

처음 실행할 때 Apple이 앱을 확인할 수 없다는 메시지가 표시되면 다음을 실행하세요:

```bash
xattr -dr com.apple.quarantine /Applications/codexhost.app
```

그런 다음 `codexhost`를 다시 실행하세요.

**Windows** - 휴대용 Codex Desktop

휴대용 Codex Desktop을 사용하는 경우, codexhost를 실행하기 전에 `CODEXHOST_INSTALL_ROOT`를 `app\ChatGPT.exe`가 포함된 디렉터리로 설정하세요:

```powershell
[Environment]::SetEnvironmentVariable("CODEXHOST_INSTALL_ROOT", "D:\CodexPortable", "User")
```

새 터미널을 열고 codexhost를 시작하세요.

</details>

<details>
<summary><h3>원격 Harness</h3></summary>

로컬 Codex Desktop에서 원격 노드의 Harness를 사용하여 원격 컴퓨터에서 작업을 실행하면서 Codex Desktop의 통합 인터페이스를 계속 사용할 수 있습니다. 양쪽 끝에 동일한 버전의 codexhost를 설치해야 합니다.

**두 가지 연결 방식을 지원합니다:**

#### 1️⃣ SSH 원격 (Mac/Linux 서버에 권장)

Codex Desktop의 기본 SSH 작업 공간을 통해 SSH를 통해 다른 개발 노드의 Harness에 연결하고 제어할 수 있습니다.

| 클라이언트 ↓ / 원격 Host → | macOS | Linux | Windows |
| --- | --- | --- | --- |
| macOS | ✅ | ✅ | ❌ |
| Linux | ✅ | ✅ | ❌ |
| Windows | ✅ | ✅ | ❌ |

SSH 원격 Host에서 실행하세요:

```bash
npm install -g @codexhost/cli
codexhost remote install
codexhost remote start
codexhost remote status
```

그런 다음 로컬 codexhost를 통해 Codex Desktop을 시작하고 SSH 작업 공간을 연 뒤, 원격 composer의 Agent/Model 선택기에서 원하는 Harness를 선택하세요.

[SSH 원격 설정, 진단 및 제거 문서 보기 →](remote-ssh-host.md)

#### 2️⃣ Remote Control 원격 (실험 · Windows에 권장)

Windows가 제어 대상 Host인 경우, codexhost는 Codex Desktop의 공식 페어링, 계정 인증 및 relay를 유지하면서 Windows에 설치되고 인증된 Harness를 이미 페어링된 다른 컴퓨터의 Codex Desktop에서 사용할 수 있습니다. 두 컴퓨터 모두 동일한 codexhost 빌드가 필요하며, 공식 Remote Control을 통해 기본 Codex가 이미 작동해야 합니다.

이 연결 방식은 공개 서비스나 TCP 리스너를 추가하지 않습니다. Harness 자격 증명은 제어 대상 Windows 컴퓨터에 그대로 유지됩니다.

[Remote Control 요구 사항, 전송 경계 및 진단 →](remote-control-host.md)

</details>

<details>
<summary><h3>작동 방식</h3></summary>

대부분의 멀티 에이전트 클라이언트는 [ACP](https://agentclientprotocol.com/) 프로토콜을 통해 여러 Harness를 연결합니다. 통합은 빠르지만 도구, 승인, 권한, Diff, 질문과 같은 기본 기능이 먼저 공통분모로 축소된 후 UI에서 다시 근사하게 구현됩니다.

CodexHost는 다른 방식을 사용합니다.

- **Desktop 계층**: CDP / Electron Inspector를 사용해 공식 Codex Desktop에 Agent 선택과 세션 제어 기능을 추가합니다. 채팅 UI를 다시 만들지 않으며 공식 설치 프로그램도 수정하지 않습니다.
- **프로토콜 계층**: CLI Shim을 사용해 공식 app-server에 투명하게 연결하고 Codex 요청을 변경 없이 전달합니다.
- **Harness 계층**: 각 Harness의 기본 인터페이스를 사용해 통합합니다. Pi는 공식 RPC를 사용하고 Claude Code는 Agent SDK / CLI를 사용한 다음, 결과를 Desktop의 스트리밍 출력, 도구, Diff, 승인 및 질문 UI에 반영합니다.

목표는 단순히 대화가 가능하게 만드는 것이 아니라 높은 충실도를 유지하는 것입니다. 스트리밍, 도구 상태, 안정적인 Patch, 기본 승인과 질문은 가능한 한 Host가 추측하거나 만들어 내지 않고 Harness 자체에서 제공됩니다.

</details>

### 상호작용 예시

OMP가 Agent 선택기에 통합되어 Codex Desktop에서 독립 Agent로 사용하여 세션을 생성하고 복원할 수 있습니다.

<table>
  <tr>
    <td width="50%">
      <img width="100%" alt="codexhost-demo-github-gif-1" src="https://github.com/user-attachments/assets/6974f178-53a7-4b85-a6d2-c25eb49816bd" />
    </td>
    <td width="50%">
      <img width="100%" alt="codexhost-demo-github-gif-2" src="https://github.com/user-attachments/assets/b0336bfd-a614-4f2e-bf98-af1b45fbaee4" />
    </td>
  </tr>
</table>

<table>
  <tr>
    <td width="50%" valign="top">
      <p><strong>Agent 및 Model 선택</strong></p>
      <img src="imgs/agent-harness-selector.png" alt="작업 제출 전에 실제 실행할 Agent와 Model을 선택할 수 있으며 Codex, Pi, Claude Code, DeepSeek Harness, Grok, Oh My Pi를 사용할 수 있습니다">
    </td>
    <td width="50%" valign="top">
      <p><strong>Usage 및 비용 정보</strong></p>
      <img src="imgs/usage-panel.png" alt="Usage 패널에서 컨텍스트, 캐시 적중 및 예상 비용을 확인할 수 있습니다">
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <p><strong>Mermaid 다이어그램 렌더링</strong></p>
      <img src="imgs/codex-vs-pi-agent-tui.png" alt="Pi + Codex Desktop과 Pi Agent TUI의 Mermaid 다이어그램 렌더링 비교">
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <img src="imgs/grok-usage-limits.png" alt="5시간 및 7일 기간의 남은 한도와 초기화 시간">
    </td>
  </tr>
</table>

## 감사의 글

- 지속적인 지원을 보내 주신 [LINUX DO](https://linux.do/) 커뮤니티에 감사드립니다.
- 멀티 Harness 통합 방식과 아키텍처에 영감을 주고 참고가 된 [Paseo](https://github.com/getpaseo/paseo) 프로젝트에 감사드립니다.
