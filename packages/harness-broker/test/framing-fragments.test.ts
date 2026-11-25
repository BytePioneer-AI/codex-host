import net from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { consumeBrokerFrames } from "../src/framing.js";

const sockets: net.Socket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
});

function reader(maxBytes: number) {
  const socket = new net.Socket();
  sockets.push(socket);
  const values: unknown[] = [];
  const error = vi.fn();
  consumeBrokerFrames(socket, (value) => values.push(value), error, maxBytes);
  return { socket, values, error };
}

it("bounds each frame independently when several frames arrive in one socket chunk", () => {
  const r = reader(4);
  r.socket.emit("data", Buffer.from('"a"\n"b"\n'));
  expect(r.values).toEqual(["a", "b"]);
  expect(r.error).not.toHaveBeenCalled();
});

it("reassembles a fragmented UTF-8 frame and a following frame without losing boundaries", () => {
  const r = reader(64);
  const data = Buffer.from(JSON.stringify({ message: "中文" }) + '\n"next"\n');
  for (const byte of data) r.socket.emit("data", Buffer.from([byte]));
  expect(r.values).toEqual([{ message: "中文" }, "next"]);
  expect(r.error).not.toHaveBeenCalled();
});

it("counts the delimiter in the frame budget and stops on an oversized fragmented frame", () => {
  const r = reader(4);
  r.socket.emit("data", Buffer.from('"ab"'));
  r.socket.emit("data", Buffer.from('\n"c"\n'));
  expect(r.values).toEqual([]);
  expect(r.error).toHaveBeenCalledOnce();
  expect(r.socket.destroyed).toBe(true);
});
