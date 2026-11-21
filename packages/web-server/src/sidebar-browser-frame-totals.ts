const REPORT_MS = 30_000;

/** Interval byte totals for all label viewers, including those without authenticated signaling. */
export class SidebarBrowserFrameTotals {
  private readonly bytes = { direct: 0, socket: 0 };
  private readonly report = setInterval(() => this.flush(), REPORT_MS).unref();

  add = (via: "direct" | "socket", bytes: number): void => {
    this.bytes[via] += bytes;
  };

  close(): void {
    clearInterval(this.report);
    this.flush();
  }

  private flush(): void {
    if (this.bytes.direct === 0 && this.bytes.socket === 0) return;
    console.info(
      "[direct] frames",
      JSON.stringify({ directBytes: this.bytes.direct, socketBytes: this.bytes.socket }),
    );
    this.bytes.direct = this.bytes.socket = 0;
  }
}
