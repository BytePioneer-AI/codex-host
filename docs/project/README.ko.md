<div align="center">

# CodexHost

**Codex Desktop에서 Pi와 다른 Harness를 실행하세요**

저희는 **Codex Desktop**이 현재 최고의 데스크톱 개발 경험을 제공한다고 생각합니다

하지만 **Codex**만이 뛰어난 **Agent Harness**는 아닙니다. **Claude Code**, **Pi**도 있습니다

**CodexHost**를 사용하면 **Codex Desktop**에서 다른 **Harness**를 네이티브로 사용하고, 서로 협업하게 할 수 있습니다

⭐ 이 프로젝트가 도움이 되었다면 Star를 눌러 주세요! ⭐

<p>
  <a href="https://pi.dev/"><img alt="Pi" src="https://img.shields.io/badge/Pi-000000?logo=pi&logoColor=white" /></a>
  <a href="https://openai.com/codex/"><img alt="Codex" src="../imgs/badge-codex.svg" /></a>
  <a href="https://code.claude.com/docs/en/quickstart"><img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-D97757?logo=claudecode&logoColor=white" /></a>
  <a href="https://opencode.ai/docs/"><img alt="OpenCode" src="../imgs/badge-opencode.svg" /></a>
  <a href="https://grok.com/"><img alt="Grok" src="https://img.shields.io/badge/Grok-000000?logo=x&logoColor=white" /></a>
  <a href="https://github.com/can1357/oh-my-pi"><img alt="Oh My Pi" src="../imgs/badge-omp-v5.svg" /></a><br />
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek_Harness-4D6BFE?logo=deepseek&logoColor=white" /></a>
  <a href="https://antigravity.google/product/antigravity-cli"><img alt="AGY" src="../imgs/badge-agy.svg" /></a>
  <a href="https://kiro.dev/docs/cli/"><img alt="Kiro CLI" src="../imgs/badge-kiro.svg" /></a>
  <a href="https://www.codebuddy.cn/home/"><img alt="CodeBuddy" src="../imgs/badge-codebuddy.svg" /></a>
  <a href="https://www.workbuddy.ai/docs/workbuddy/Quickstart"><img alt="WorkBuddy" src="../imgs/badge-workbuddy.svg" /></a>
  <a href="https://cursor.com/docs/cli/overview"><img alt="Cursor" src="../imgs/badge-cursor.svg" /></a>
  <a href="https://hermes-agent.nousresearch.com/docs"><img alt="Hermes" src="../imgs/badge-hermes.svg" /></a>
  <a href="https://qoder.com/cli"><img alt="Qoder" src="../imgs/badge-qoder.svg" /></a>
</p>
<br />

<p align="center"><a href="https://github.com/BytePioneer-AI/codex-host/releases"><strong>다운로드</strong></a> · <a href="#agent-간-협업">Agent 간 협업</a> · <a href="#원격-harness">원격 연결</a> · <a href="#교류-그룹-참여">교류 그룹</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="../../README.md">English</a></p>

<br />

</div>

## 인터페이스 미리보기

앱을 전환하지 않고도 **Pi, Claude Code, Grok Build 등 10개 이상의 Harness**를 하나의 Codex Desktop 창에서 바로 사용할 수 있습니다.

https://github.com/user-attachments/assets/c48192d7-23ff-4f6e-b61a-6345a655bb76

### 인터페이스

<div align="center">
  <img width="90%" src="../imgs/codexhost-native-overview.png" alt="Codex Desktop에서 실행 중인 Claude Code, Pi, Grok Build, Oh My Pi 세션과 Diff 검토, Fork, Worktree, Agent 전환">
</div>

## 빠른 시작

**방법 1: npm** (macOS / Windows / Linux)

```bash
npm install -g @codexhost/cli
codexhost
```

**방법 2: 설치 프로그램** (macOS / Windows)

[Releases](https://github.com/BytePioneer-AI/codex-host/releases)에서 플랫폼에 맞는 설치 프로그램을 다운로드하세요.

> Linux는 x64 / ARM64를 지원합니다. 자세한 내용은 [Linux 안내](../platforms/linux/linux.md)를 참고하세요.

<details>
<summary>설치 문제 해결</summary>

**macOS: 처음 열 때 "앱을 확인할 수 없음" 메시지가 표시됨**

```bash
xattr -dr com.apple.quarantine /Applications/codexhost.app
```

**Windows: 압축 해제형(포터블) Codex Desktop 사용**

1. `CODEXHOST_INSTALL_ROOT`를 Codex Desktop 압축 해제 디렉터리로 설정합니다:

   ```powershell
   [Environment]::SetEnvironmentVariable("CODEXHOST_INSTALL_ROOT", "D:\CodexPortable", "User")
   ```

2. Codex Desktop을 완전히 종료하고 새 터미널을 연 뒤 `codexhost`를 실행합니다.

</details>

### 주요 기능

<table>
  <tr>
    <td colspan="2" valign="top">
      <p><strong>전체 작업 화면</strong><br /><sub>여러 Harness의 세션이 하나의 사이드바에 모이고, 입력창 오른쪽 아래에서 언제든 Agent를 전환</sub></p>
      <div align="center">
        <img width="90%" src="../imgs/codexhost-full-workspace.png" alt="Codex Desktop에서 실행 중인 codexhost 전체 작업 화면: 프로젝트 구조, 대화 영역, 여러 Agent 선택기">
      </div>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <p><strong>Diff 검토 패널</strong><br /><sub>매 턴의 변경 사항을 자동으로 요약하고, 「검토」를 누르면 오른쪽에서 전체 Diff 확인</sub></p>
      <img src="../imgs/highlight-diff-review.png" alt="대화의 변경 요약 카드와 오른쪽 검토 패널의 Diff">
    </td>
    <td width="50%" valign="top">
      <p><strong>아무 메시지에서나 Fork</strong><br /><sub>현재 작업 공간에서, 또는 새 Worktree에서 병렬 개발</sub></p>
      <img src="../imgs/highlight-fork-worktree.png" alt="메시지에서 브랜치를 만드는 메뉴: 현재 작업 공간 또는 새 워크트리">
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <p><strong># 입력으로 다른 Agent에 위임</strong><br /><sub>여러 Agent가 각자 독립 세션에서 병렬 실행 · <a href="#agent-간-협업">자세히 보기</a></sub></p>
      <img src="../imgs/highlight-delegation.png" alt="# 입력으로 Codex, Claude Code, Grok 등 Agent를 선택하고 각 작업이 독립 세션에서 병렬 실행">
    </td>
    <td width="50%" valign="top">
      <p><strong>도구 호출과 사고 과정</strong><br /><sub>모든 edit, 명령, 사고 과정을 펼쳐서 자세히 확인</sub></p>
      <img src="../imgs/highlight-tool-details.png" alt="편집 기록을 펼쳐 새로 만든 파일의 Diff 표시">
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <p><strong>Subagent 가시화</strong><br /><sub>Subagent마다 고유 아이콘이 있고, 오른쪽에서 전체 대화 확인</sub></p>
      <img src="../imgs/highlight-subagent.png" alt="메인 대화에 4개 Subagent 상태가 표시되고 오른쪽에 그중 하나의 전체 대화">
    </td>
    <td width="50%" valign="top">
      <p><strong>원격 개발</strong><br /><sub>VPS를 프로젝트로 추가하면 Agent가 원격 머신에서 바로 실행 · <a href="#원격-harness">자세히 보기</a></sub></p>
      <img src="../imgs/highlight-remote.png" alt="사이드바의 원격 VPS 프로젝트와 원격 머신의 작업 디렉터리를 반환하는 대화">
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <p><strong>사용량 한눈에 보기</strong><br /><sub>캐시 적중률, 예상 비용, 컨텍스트 사용량을 실시간 표시</sub></p>
      <img src="../imgs/highlight-usage.png" alt="사용량 팝오버: 컨텍스트, 캐시 적중률, 캐시 읽기/쓰기, 총 Token, 예상 비용">
    </td>
    <td width="50%" valign="top">
      <p><strong>계정 원클릭 가져오기</strong><br /><sub>로컬에 로그인된 Codex, Grok 자격 증명을 Pi로 바로 복사하고 한도를 실시간 확인</sub></p>
      <img src="../imgs/highlight-account-import.png" alt="계정 설정: 5시간·7일 남은 한도와 Pi로 가져온 계정">
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <p><strong>Mermaid 다이어그램 렌더링</strong><br /><sub>왼쪽: Codex Desktop + Pi는 다이어그램을 바로 렌더링, 오른쪽: Pi TUI는 소스만 표시</sub></p>
      <img src="../imgs/codex-vs-pi-agent-tui.png" alt="Pi + Codex Desktop과 Pi Agent TUI의 Mermaid 다이어그램 렌더링 비교">
    </td>
  </tr>
</table>

## 기능 상태

모든 Harness에서 Codex Desktop 네이티브 Edit Diff, Fork, 메시지 수정, 슬래시 명령을 사용할 수 있습니다.

<details>
<summary>전체 기능 매트릭스 보기</summary>

| 기능 | <a href="https://pi.dev/"><img alt="Pi" src="https://img.shields.io/badge/-000000?logo=pi&logoColor=white" /></a> | <a href="https://github.com/can1357/oh-my-pi"><img alt="Oh My Pi" src="../imgs/harness-icon-omp-v5.svg" /></a> | <a href="https://code.claude.com/docs/en/quickstart"><img alt="Claude Code" src="https://img.shields.io/badge/-D97757?logo=claudecode&logoColor=white" /></a> | <a href="https://opencode.ai/docs/"><img alt="OpenCode" src="../imgs/harness-icon-opencode.svg" /></a> | <a href="https://grok.com/"><img alt="Grok" src="https://img.shields.io/badge/-000000?logo=x&logoColor=white" /></a> | <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/-4D6BFE?logo=deepseek&logoColor=white" /></a> | <a href="https://antigravity.google/product/antigravity-cli"><img alt="AGY" src="../imgs/harness-icon-agy.svg" /></a> | <a href="https://www.codebuddy.cn/home/"><img alt="CodeBuddy" src="../imgs/harness-icon-codebuddy.svg" width="24" height="24" /></a> | <a href="https://www.workbuddy.ai/docs/workbuddy/Quickstart"><img alt="WorkBuddy" src="../../packages/adapters/workbuddy/assets/icon.svg" width="24" height="24" /></a> | <a href="https://cursor.com/docs/cli/overview"><img alt="Cursor" src="../imgs/harness-icon-cursor.svg" /></a> | <a href="https://hermes-agent.nousresearch.com/docs"><img alt="Hermes" src="../imgs/harness-icon-hermes.svg" /></a> | <a href="https://qoder.com/cli"><img alt="Qoder" src="../../packages/adapters/qoder/assets/icon.svg" width="28" height="28" /></a> |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| 스트리밍 응답 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 도구 상태 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Edit Diff | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 질문 / 취소 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Model / Thinking 선택 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 도구 승인 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| 권한 모드 | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Agent 간 작업 협업 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| Usage | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| Fork | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 컨텍스트 압축 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | — | ✅ | ✅ |
| 슬래시 명령 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 이전 메시지 수정 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

</details>

## Agent 간 협업

채팅 입력창에 `#`을 입력하면 작업을 위임할 Agent를 선택하거나 현재 선택한 Harness에서 사용할 수 있는 명령과 스킬을 찾을 수 있습니다.

현재 Agent에게 독립 작업을 다른 Harness로 넘기도록 요청할 수 있습니다. 예를 들면 다음과 같습니다.

> `claude-code`에게 이 변경 사항을 독립적으로 검토하고 호환성 위험을 지적하도록 요청하세요.
>
> `pi`에게 이 테스트가 간헐적으로 실패하는 원인을 조사하도록 요청하세요.
>
> 제가 문서를 정리하는 동안 `omp`에게 이 기능을 구현하도록 요청하세요.
>
> `opencode`에게 독립 Thread에서 이 수정을 검증하고 관련 테스트를 실행하도록 요청하세요.

CodexHost는 대상 Harness를 위한 별도의 Native Session을 만듭니다. 위임된 Session은 Codex Desktop의 대화 목록에 표시되며, 언제든 열어서 진행 상황을 확인하거나 대화를 이어갈 수 있습니다.

<details>
<summary><h3 id="원격-harness">원격 Harness</h3></summary>

로컬 Codex Desktop에서 제어 대상 컴퓨터의 Harness를 사용합니다. 작업은 제어 대상 컴퓨터에서 실행되고 UI는 로컬에 그대로 있습니다. 양쪽에 동일한 버전의 codexhost를 설치해야 합니다.

| 제어 대상 컴퓨터 | 연결 방식 |
| --- | --- |
| macOS / Linux | [SSH 원격](#ssh-원격) |
| Windows | [Remote Control 원격](#remote-control-원격-실험)(실험) |

#### SSH 원격

전제 조건: Codex Desktop의 **설정 → 연결 → SSH**에 제어 대상 컴퓨터가 추가되어 있어야 합니다. 클라이언트는 macOS / Linux / Windows를 지원합니다.

<div align="center">
  <img width="70%" src="../imgs/remote-ssh-connections.png" alt="Codex Desktop 설정 → 연결 → SSH 페이지에 추가된 SSH 연결">
</div>

1. 제어 대상 컴퓨터에서 설치하고 시작합니다:

   ```bash
   npm install -g @codexhost/cli
   codexhost remote install
   codexhost remote start
   codexhost remote status
   ```

2. 로컬에서 codexhost로 Codex Desktop을 시작하고 SSH 작업 공간을 엽니다.
3. 입력창의 Agent / Model 선택기에서 대상 Harness를 선택합니다.

[SSH 설정, 진단 및 제거 →](../platforms/remote/remote-ssh-host.md)

#### Remote Control 원격 (실험)

Codex Desktop 공식 Remote Control의 페어링과 인증을 재사용하여, 다른 컴퓨터에서 Windows의 Harness를 사용합니다.

전제 조건: 공식 Remote Control에서 Codex 작업이 정상적으로 실행되어야 합니다. 공개 서비스나 포트를 추가하지 않으며, Harness 자격 증명은 Windows에만 유지됩니다.

[Remote Control 설정, 전송 경계 및 진단 →](../platforms/remote/remote-control-host.md)

</details>

<details>
<summary><h3>작동 방식</h3></summary>

대부분의 멀티 에이전트 클라이언트는 자체 채팅 UI를 새로 만들고, 공통 프로토콜로 여러 Harness를 연결합니다.

CodexHost는 다른 방식을 택합니다.

- **Desktop 측**: CDP / Electron Inspector로 공식 Codex Desktop을 확장하며, 채팅 UI를 다시 만들거나 공식 설치 프로그램을 수정하지 않습니다
- **프로토콜 측**: CLI Shim으로 공식 app-server에 연결하며, 네이티브 Codex 요청은 그대로 전달되어 영향을 받지 않습니다
- **Harness 측**: 각 Harness의 네이티브 인터페이스를 우선 사용하고(Pi는 RPC, Claude Code는 Agent SDK), 네이티브 인터페이스가 없으면 [ACP](https://agentclientprotocol.com/)로 연결합니다. 스트리밍 출력, 도구 상태, Diff, 승인, 질문은 모두 Codex Desktop 네이티브 UI에 투영됩니다
- **오케스트레이션 측**: 위임된 작업은 대상 Harness에서 독립적인 네이티브 세션으로 실행되며, 시작한 쪽은 결과를 기다리거나 백그라운드에서 실행하도록 선택할 수 있습니다

</details>

## 교류 그룹 참여

<table align="center">
  <tr>
    <td>
      <strong>교류 그룹 참여</strong><br />
      <sub>CodexHost 사용법과 기능에 관심 있는 개발자는 QR 코드를 스캔해 위챗 그룹에 참여할 수 있습니다.</sub>
      <ul>
        <li><sub>설치 문제는 그룹에서 질문할 수 있습니다</sub></li>
        <li><sub>기능 제안과 피드백</sub></li>
        <li><sub>개발 관련 논의</sub></li>
        <li><sub>버그는 <strong>issue</strong>로 제출해 주세요</sub></li>
      </ul>
      <sub><strong>함께 기여해 주세요.</strong></sub>
    </td>
    <td align="center">
      <img width="230" alt="위챗 그룹 QR 코드" src="../imgs/wechat-qrcode.jpg" />
    </td>
  </tr>
</table>

## 개발

Issue나 PR을 제출하기 전에 [기여 안내](../../CONTRIBUTING.md)를 읽어 주세요. PR 제목 라벨, 간단한 CI 결과, 릴리스 전 검증은 [저장소 유지 관리 자동화](../operations/repository-maintenance.md)를 참고하세요.

환경 요구 사항: 공식 Codex Desktop, Node.js 22.19+ 또는 24, Rust.

```bash
git clone https://github.com/BytePioneer-AI/codex-host
cd codex-host
npm ci
npm start
```

### 실행 아키텍처

Pi를 예로 듭니다. 왼쪽에서 오른쪽이 한 번의 요청 호출 체인입니다: Desktop → 공용 계층 → Pi 플러그인 → 네이티브 프로세스.

<div align="center">
  <img width="100%" src="../imgs/pi-runtime-architecture.png" alt="Pi를 예로 든 실행 아키텍처: Desktop에서 공용 계층, 이어서 Pi 플러그인과 네이티브 프로세스">
</div>

### Harness 추가

주요 작업은 플러그인의 Manifest, 팩토리, Adapter, Session 및 네이티브 통신과 변환 로직을 구현하는 것입니다. 현재 Renderer에는 여전히 정적 연결이 있어, 완전한 Desktop 연동은 별도로 처리해야 합니다.
Harness를 추가할 때는 코딩 Agent가 저장소의 [codexhost-add-harness Skill](../../.agents/skills/codexhost-add-harness/SKILL.md)을 사용하도록 할 수 있습니다. 플러그인 구조, 공용 Adapter 인터페이스, 기능 구현과 테스트 요구 사항을 설명합니다.

## 감사의 글

- 지속적인 지원을 보내 주신 [LINUX DO](https://linux.do/) 커뮤니티에 감사드립니다.
- 멀티 Harness 통합 방식과 아키텍처에 영감을 주고 참고가 된 [Paseo](https://github.com/getpaseo/paseo) 프로젝트에 감사드립니다.

## Star History

<a href="https://www.star-history.com/?repos=bytepioneer-ai%2Fcodex-host&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=bytepioneer-ai/codex-host&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=bytepioneer-ai/codex-host&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=bytepioneer-ai/codex-host&type=date&legend=top-left" />
  </picture>
</a>
