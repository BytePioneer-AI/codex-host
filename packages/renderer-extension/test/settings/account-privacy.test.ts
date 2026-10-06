import { describe, expect, it } from "vitest";

import {
  accountDisplayText,
  maskEmailLocalPart,
  maskEmails,
} from "../../src/settings/account-privacy.js";

describe("Account email masking", () => {
  it("keeps both ends of the local part and the whole domain", () => {
    expect(maskEmails("zhaobin_jiang@163.com")).toBe("zh****ng@163.com");
    expect(maskEmails("9s74s7y5fd@privaterelay.appleid.com")).toBe(
      "9s****fd@privaterelay.appleid.com",
    );
  });

  it("uses a fixed-width mask so short and long names do not reveal their length", () => {
    expect(maskEmailLocalPart("a")).toBe("****");
    expect(maskEmailLocalPart("ab")).toBe("a****");
    expect(maskEmailLocalPart("abcd")).toBe("a****d");
    expect(maskEmailLocalPart("abcdefghijklmnop")).toBe("ab****op");
  });

  it("leaves names that are not emails unchanged and masks emails inside longer text", () => {
    expect(maskEmails("DeepSeek")).toBe("DeepSeek");
    expect(maskEmails("Kimi Code")).toBe("Kimi Code");
    expect(maskEmails("Native · me@example.com")).toBe("Native · m****@example.com");
  });

  it("only masks when emails are hidden", () => {
    expect(accountDisplayText("me@example.com", false)).toBe("me@example.com");
    expect(accountDisplayText("alice@example.com", true)).toBe("al****ce@example.com");
  });
});
