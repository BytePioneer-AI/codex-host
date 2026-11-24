// Loaded only by the disposable OMP subprocess. No credential leaves native AuthStorage.
export const billingSourceExtension = `
import { createAgentSession, SessionManager, Settings } from '@oh-my-pi/pi-coding-agent';

export default function(pi) {
  let session, manager, selected, started = false, createDispatched = false;
  const reply = (id, data) => process.stdout.write(JSON.stringify({ codexhostBillingSource: id, ...data }) + '\\n');
  async function dispose() {
    if (!session) return !createDispatched;
    if (manager.getSessionFile() !== undefined) return false;
    await session.dispose();
    return manager.getSessionFile() === undefined;
  }
  async function selectedCredential(registry, provider, credentialId, identityKey) {
    const auth = registry.authStorage;
    await auth.credentials.revalidate();
    const rows = auth.credentials.snapshot().credentials.filter(row => row.provider === provider);
    const row = rows.find(row => row.id === credentialId);
    if (!row?.identityKey || row.identityKey !== identityKey || row.credential.type !== 'oauth' ||
        rows.filter(other => other.identityKey === identityKey).length !== 1) return undefined;
    return row;
  }
  pi.registerCommand('codexhost-billing-source', {
    async handler(args, ctx) {
      let id;
      try {
        const command = JSON.parse(Buffer.from(args, 'base64url').toString('utf8'));
        id = command.id;
        if (command.type === 'accounts') {
          const auth = ctx.modelRegistry.authStorage;
          await auth.credentials.revalidate();
          const accounts = auth.credentials.snapshot().credentials
            .filter(row => row.credential.type === 'oauth' && row.identityKey)
            .map(row => ({ provider: row.provider, credentialId: row.id, identityKey: row.identityKey }));
          return reply(id, { code: 'accounts', accounts });
        }
        if (command.type === 'prepare' && !session) {
          const { provider, credentialId, identityKey, modelId } = command;
          const registry = ctx.modelRegistry;
          const row = await selectedCredential(registry, provider, credentialId, identityKey);
          if (!row) return reply(id, { code: 'account' });
          const model = modelId ? registry.find(provider, modelId) :
            registry.getAvailable().find(candidate => candidate.provider === provider);
          if (!model || model.provider !== provider) return reply(id, { code: 'model' });
          const assertModel = candidate => {
            if (candidate?.provider !== provider || candidate.id !== model.id) {
              throw new Error('Billing Source Model changed');
            }
          };
          const settings = Settings.isolated({ retry: { enabled: false } });
          manager = SessionManager.inMemory(ctx.cwd);
          createDispatched = true;
          ({ session } = await createAgentSession({
            cwd: ctx.cwd, modelRegistry: registry, model, settings, sessionManager: manager,
            oauthAccountPools: { [provider]: [row.identityKey] },
            assertDispatchModel: assertModel, disableModelFallback: true,
            disableServerSideFallback: true, allowSessionModelFallback: false,
            toolNames: [], restrictToolNames: true, enableMCP: false, enableLsp: false,
            skipPythonPreflight: true, disableExtensionDiscovery: true,
            noContextFiles: true, skills: [], rules: [], promptTemplates: [], slashCommands: [],
            suppressAutoPrewalk: true, systemPrompt: 'Reply with OK.', thinkingLevel: 'off',
          }));
          assertModel(session.model);
          if (manager.getSessionFile() !== undefined) throw new Error('Expected an in-memory Session');
          selected = { provider, credentialId, identityKey, modelId: model.id };
          return reply(id, { code: 'ready', ...selected });
        }
        if (command.type === 'turn' && selected && !started) {
          started = true;
          let completed = false;
          try {
            await session.prompt(command.text, { expandPromptTemplates: false });
            await session.waitForIdle();
            const current = await selectedCredential(
              ctx.modelRegistry, selected.provider, selected.credentialId, selected.identityKey,
            );
            const assistant = session.messages.filter(message => message.role === 'assistant');
            completed = !!current && assistant.length > 0 && assistant.every(message =>
              message.provider === selected.provider && message.credentialId === selected.credentialId &&
              (!('identityKey' in message) || message.identityKey === selected.identityKey) &&
              (message.stopReason === 'stop' || message.stopReason === 'length'));
          } catch {
            // A failed/denied Turn can still have a confirmed in-memory cleanup.
          }
          const clean = await dispose().catch(() => false);
          session = undefined;
          reply(id, { code: completed ? 'completed' : 'failed', ...(completed ? selected : {}),
            cleanup: clean ? 'not-persisted' : null });
          return;
        }
        if (command.type === 'dispose') {
          const clean = await dispose();
          session = undefined;
          return reply(id, { code: 'disposed', cleanup: clean ? 'not-persisted' : null });
        }
        reply(id, { code: 'protocol' });
      } catch {
        reply(id, { code: 'protocol' });
      }
    },
  });
  reply(process.env.CODEXHOST_OMP_BILLING_HELLO, { code: 'registered' });
}
`;
