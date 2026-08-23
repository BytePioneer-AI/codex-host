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
</p>

<p align="center">
  <sub><a href="../README.md">简体中文</a> · <a href="README.en.md">English</a> · 한국어</sub>
</p>
</div>

## 인터페이스 미리보기

앱을 전환하지 않고도 **Pi, Claude Code, Grok Build, DeepSeek Harness**를 하나의 Codex Desktop 창에서 바로 사용할 수 있습니다.

![Codex Desktop에서 실행 중인 Pi와 Claude Code 전체 데모](imgs/demo.gif)

### 인터페이스

![Codex Desktop에서 실행 중인 Pi, Claude Code, DeepSeek Harness](imgs/app-overview.png)

## 기능 상태

| 기능 | Codex | Pi | Claude Code | Grok Build | DeepSeek Harness |
| --- | --- | --- | --- | --- | --- |
| 스트리밍 응답 | 기본 제공 | ✅ | ✅ | ✅ | ✅ |
| Thinking | 기본 제공 | ✅ | ✅ | ✅ | — |
| 도구 상태 | 기본 제공 | ✅ | ✅ | ✅ | ✅ |
| Edit Diff | 기본 제공 | ✅ | ✅ | ✅ | ✅ |
| 질문 / 취소 | 기본 제공 | ✅ | ✅ | ✅ | ✅ |
| Model / Thinking 선택 | 기본 제공 | ✅ | ✅ | ✅ | 🚧 |
| 도구 승인 | 기본 제공 | ✅ | ✅ | ✅ | ✅ |
| 권한 모드 | 기본 제공 | — | ✅ | ✅ | — |
| Usage | 기본 제공 | ✅ | ✅ | ✅ | ✅ |
| 세션 복원 | 기본 제공 | ✅ | ✅ | ✅ | ✅ |
| Fork | 기본 제공 | ✅ | ✅ | ✅ | — |
| 컨텍스트 압축 | 기본 제공 | ✅ | ✅ | ✅ | ✅ |
| 슬래시 명령 | 기본 제공 | ✅ | 🚧 | ✅ | — |
| 이전 메시지 수정 | 기본 제공 | ✅ | 🚧 | ✅ | — |

> **SSH 원격 Harness**: ✅ Codex Desktop의 기본 SSH 작업 공간을 통해 원격 노드의 Harness를 사용할 수 있습니다.

## 빠른 시작

**방법 1: npm으로 설치**

```bash
npm install -g @codexhost/cli
codexhost
```

npm은 macOS, Windows 및 [x64 Linux](linux.md)를 지원합니다.

**방법 2: 설치 프로그램 다운로드**

[GitHub Releases](https://github.com/BytePioneer-AI/codex-host/releases)에서 최신 설치 프로그램을 다운로드한 다음 운영체제와 CPU 아키텍처에 맞는 파일을 선택하세요. 현재 설치 프로그램은 macOS와 Windows를 지원합니다.

macOS에서 처음 실행할 때 Apple이 앱을 확인할 수 없다는 메시지가 표시되면 터미널에서 다음 명령을 실행하세요:

```bash
xattr -dr com.apple.quarantine /Applications/codexhost.app
```

그런 다음 `codexhost`를 다시 실행하세요.

Windows에서 압축 해제 방식의 Codex Desktop을 사용하는 경우, codexhost를 실행하기 전에 `CODEXHOST_INSTALL_ROOT`를 `app\ChatGPT.exe`가 포함된 디렉터리로 설정하세요:

```powershell
[Environment]::SetEnvironmentVariable("CODEXHOST_INSTALL_ROOT", "D:\CodexPortable", "User")
```

새 터미널을 열고 codexhost를 시작하세요. 이 설정은 npm 명령과 Windows 설치 프로그램 모두에 적용됩니다.

### SSH 원격 Harness

로컬 Codex Desktop에서 SSH를 통해 다른 개발 노드의 Harness에 연결하고 제어할 수 있으며, 원격 컴퓨터에서 작업을 실행하면서 Codex Desktop의 통합 인터페이스를 계속 사용할 수 있습니다.

양쪽 컴퓨터에 동일한 버전의 codexhost를 설치하고 Codex Desktop의 기본 SSH 작업 공간이 정상적으로 작동하는지 확인하세요.

| 클라이언트 ↓ / 원격 Host → | macOS | Linux | Windows |
| --- | --- | --- | --- |
| macOS | ✅ | ✅ | ❌ |
| Linux | ✅ | ✅ | ❌ |
| Windows | ✅ | ✅ | ❌ |

Windows는 클라이언트로 사용할 수 있지만 원격 Host로는 현재 지원되지 않습니다. 원격 Host는 macOS 또는 Linux에서 실행되어야 합니다.

SSH 원격 Host에서 실행하세요:

```bash
npm install -g @codexhost/cli
codexhost remote install
codexhost remote status
```

그런 다음 로컬 codexhost를 통해 Codex Desktop을 시작하고 SSH 작업 공간을 연 뒤, 원격 composer의 Agent/Model 선택기에서 원하는 Harness를 선택하세요.

[SSH 원격 설정, 진단 및 제거 문서 보기 →](remote-ssh-host.md)

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

<table>
  <tr>
    <td width="50%" valign="top">
      <p><strong>Agent 및 Model 선택</strong></p>
      <img src="imgs/grok-agent-selector.png" alt="작업 제출 전에 실제 실행할 Agent와 Model을 선택할 수 있으며 Grok이 목록에 추가되었습니다">
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
      <p><strong>Grok 예시</strong></p>
      <img src="imgs/grok-account-credits.png" alt="Grok 예시: 계정 크레딧, 주간 한도, 사용량 및 초기화 시간을 한눈에 확인할 수 있습니다">
    </td>
  </tr>
</table>

## 감사의 글

- 지속적인 지원을 보내 주신 [LINUX DO](https://linux.do/) 커뮤니티에 감사드립니다.
- 멀티 Harness 통합 방식과 아키텍처에 영감을 주고 참고가 된 [Paseo](https://github.com/getpaseo/paseo) 프로젝트에 감사드립니다.
