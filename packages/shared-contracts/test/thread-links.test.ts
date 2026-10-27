import { expect, it } from "vitest";
import { formatThreadReference, parseThreadReference } from "../src/thread-links.js";

const machineId = "12345678-1234-4123-8123-123456789abc";
it("round trips a portable link, keeping the Desktop navigation hint", () => {
  const reference = { threadId: "thread-1", hostId: "remote-ssh:中文", machineId };
  const link = formatThreadReference(reference);
  expect(parseThreadReference(link)).toEqual(reference);
  expect(parseThreadReference(link.replace("thread://", "codex://threads/"))).toEqual(reference);
  expect(parseThreadReference("thread://t?hostId=local")).toEqual({
    threadId: "t",
    hostId: "local",
  });
});

it.each([
  "thread://t?machineId=local",
  "thread://t?hostId=local&hostId=remote",
  "thread://t?machineId=123&machineId=456",
  "thread://t?endpoint=http://host",
  "thread://t?hostId=",
  "thread://t?hostId=bad%0Ahost",
  "thread://%ZZ",
  "thread://t#fragment",
  "thread://a%2Fb",
  "thread://t?hostId=%ZZ",
])("rejects malformed or ambiguous link %s", (link) => {
  expect(() => parseThreadReference(link)).toThrow();
});
