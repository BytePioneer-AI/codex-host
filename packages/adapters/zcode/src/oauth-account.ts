import { z } from "zod";
import { ZcodeCredentialError } from "./credentials.js";

export type CredentialReader = (key: string) => Promise<string>;
export type LoginChannel = "zai" | "zai_cn" | "bigmodel";

export async function readLoginChannel(
  credential: CredentialReader,
): Promise<LoginChannel | undefined> {
  const active = await credential("oauth:active_provider");
  if (active === "zai" || active === "zai_cn" || active === "bigmodel") return active;
  if (active)
    throw new ZcodeCredentialError("The active ZCode login channel is not supported by CodexHost.");
}

const normalizedProfile = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
});
const rawZaiProfile = z.object({ user_id: z.string() });

export async function readOAuthUserId(credential: CredentialReader, channel: LoginChannel) {
  const raw = await credential(`oauth:${channel}:user_info`);
  if (!raw) return;
  let profile: unknown;
  try {
    profile = JSON.parse(raw);
  } catch {
    throw new ZcodeCredentialError("Cannot read the ZCode login profile.");
  }
  const id =
    normalizedProfile.safeParse(profile).data?.id ??
    (channel === "bigmodel" ? undefined : rawZaiProfile.safeParse(profile).data?.user_id);
  if (id?.trim() && id.trim() !== "unknown") return id;
}
