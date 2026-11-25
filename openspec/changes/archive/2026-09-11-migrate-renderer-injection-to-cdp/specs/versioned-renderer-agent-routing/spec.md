## MODIFIED Requirements

### Requirement: Renderer prerequisites SHALL gate only external capability availability
Renderer Model target uniqueness、Adapter readiness和Draft Prewarm clearing SHALL保持外部Agent切换与提交的必要条件。主进程Title Policy ownership在直接Renderer CDP控制模式下 MAY不可用且 MUST NOT单独阻止Renderer Adapter安装。失败 MUST使对应外部能力不可用，但 SHALL NOT终止受管Desktop或成为Launcher兼容提示。系统 MUST NOT在Title Policy未安装时伪造其ready标记或声称外部标题隔离已生效。

#### Scenario: Agent Model target在恢复期间不可用
- **WHEN** Adapter无法识别唯一受支持Composer Model target
- **THEN** Pi和Claude Code切换或提交 SHALL保持不可用
- **AND** Controller SHALL继续后台恢复且官方Codex保持可用

#### Scenario: 外部选择清理Draft Prewarm失败
- **WHEN** 外部Agent切换无法清除owned Draft prewarm
- **THEN** 切换 SHALL失败且Adapter SHALL保持外部提交不可用
- **AND** 受管Desktop SHALL继续运行并允许后续恢复

#### Scenario: 主进程Title Policy不可用
- **WHEN** Renderer通过直接CDP安装且`__codexhostMainProcessTitlePolicyV1`不存在
- **THEN** Adapter SHALL继续验证Model target、Draft routing和Host control prerequisites
- **AND** Title Policy缺失 SHALL NOT单独将Adapter置为unsupported
- **AND** Renderer SHALL NOT创建伪造的Title Policy readiness marker

## REMOVED Requirements

### Requirement: Pi title generation does not enter Codex Harness
**Reason**: The Electron main-process Inspector required to wrap the native metadata generation service is disabled by the current Codex Desktop Electron fuse. Direct Renderer CDP cannot truthfully provide this main-process boundary.

**Migration**: External Agent routing continues without a title-ready marker. Host-owned explicit Thread names remain supported; automatic external title isolation requires a later Host-owned title design.

### Requirement: External Agent title isolation is shared
**Reason**: The shared main-process title policy cannot be installed through direct Renderer CDP.

**Migration**: Do not claim title isolation in Renderer-only mode and do not synthesize readiness. Define replacement automatic-title ownership in a follow-up capability.
