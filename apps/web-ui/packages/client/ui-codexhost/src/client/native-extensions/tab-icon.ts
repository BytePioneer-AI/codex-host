type Contribution = { set(value: string | null): void; dispose(): void };
type Owner = {
  contributions: Map<object, string>;
  activeCount: number;
  update(): void;
  cleanup(): void;
};
const owners = new WeakMap<Document, Owner>();

export function createTabIconContribution(doc: Document): Contribution {
  let owner = owners.get(doc);
  if (!owner) {
    const contributions = new Map<object, string>();
    const link = doc.createElement("link");
    link.rel = "icon";
    link.type = "image/png";
    const originals: Array<{ node: Element; parent: Node; next: Node | null }> = [];
    const update = () => {
      const value =
        doc.visibilityState === "hidden" ? undefined : [...contributions.values()].at(-1);
      if (value) {
        for (const node of doc.querySelectorAll('link[rel~="icon"]')) {
          if (node !== link && node.parentNode) {
            originals.push({ node, parent: node.parentNode, next: node.nextSibling });
            node.remove();
          }
        }
        link.href = value;
        if (!link.isConnected) doc.head?.append(link);
      } else {
        link.remove();
        for (const { node, parent, next } of originals.splice(0).reverse())
          parent.insertBefore(node, next?.parentNode === parent ? next : null);
      }
    };
    const cleanup = () => {
      doc.removeEventListener("visibilitychange", update);
      owners.delete(doc);
    };
    doc.addEventListener("visibilitychange", update);
    owner = { contributions, activeCount: 0, update, cleanup };
    owners.set(doc, owner);
  }
  const current = owner;
  current.activeCount++;
  const token = {};
  let disposed = false;
  return {
    set(value) {
      if (disposed) return;
      if (
        value !== null &&
        (typeof value !== "string" ||
          value.length > 180_000 ||
          !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(value))
      )
        throw new Error("Expected a PNG data URL smaller than 128 KiB");
      current.contributions.delete(token);
      if (value) current.contributions.set(token, value);
      current.update();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      current.contributions.delete(token);
      current.activeCount--;
      current.update();
      if (current.activeCount === 0) current.cleanup();
    },
  };
}
