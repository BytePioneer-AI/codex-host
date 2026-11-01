import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { watchRemoteListenerSupervisor } from "../src/remote-listener-supervisor.js";

function brokenPipe(): NodeJS.ErrnoException {
  const error = new Error("write EPIPE") as NodeJS.ErrnoException;
  error.code = "EPIPE";
  return error;
}

describe("remote listener supervisor watch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports supervisor loss once when the listener is reparented", () => {
    vi.useFakeTimers();
    let parent = 4_242;
    const onLost = vi.fn();
    const watch = watchRemoteListenerSupervisor({
      onLost,
      outputs: [],
      parentProcessId: () => parent,
      intervalMs: 100,
    });

    vi.advanceTimersByTime(300);
    expect(onLost).not.toHaveBeenCalled();

    parent = 1;
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(500);
    expect(onLost).toHaveBeenCalledOnce();
    expect(onLost).toHaveBeenCalledWith("supervisor process 4242 exited");
    watch.close();
  });

  it("does not poll a listener that started without a supervisor", () => {
    vi.useFakeTimers();
    let parent = 1;
    const onLost = vi.fn();
    const watch = watchRemoteListenerSupervisor({
      onLost,
      outputs: [],
      parentProcessId: () => parent,
      intervalMs: 100,
    });

    parent = 7;
    vi.advanceTimersByTime(1_000);
    expect(onLost).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    watch.close();
  });

  it("reports immediate loss when a required supervisor is already gone", () => {
    vi.useFakeTimers();
    const onLost = vi.fn();
    const watch = watchRemoteListenerSupervisor({
      onLost,
      outputs: [],
      parentProcessId: () => 1,
      supervisorRequired: true,
      intervalMs: 100,
    });

    expect(onLost).toHaveBeenCalledOnce();
    expect(onLost).toHaveBeenCalledWith("supervisor exited before startup completed");
    vi.advanceTimersByTime(1_000);
    expect(onLost).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    watch.close();
  });

  it("still watches a live required supervisor", () => {
    vi.useFakeTimers();
    let parent = 4_242;
    const onLost = vi.fn();
    const watch = watchRemoteListenerSupervisor({
      onLost,
      outputs: [],
      parentProcessId: () => parent,
      supervisorRequired: true,
      intervalMs: 100,
    });

    vi.advanceTimersByTime(300);
    expect(onLost).not.toHaveBeenCalled();
    parent = 1;
    vi.advanceTimersByTime(100);
    expect(onLost).toHaveBeenCalledWith("supervisor process 4242 exited");
    watch.close();
  });

  it("treats a closed diagnostic pipe as supervisor loss instead of crashing", () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const onLost = vi.fn();
    const watch = watchRemoteListenerSupervisor({
      onLost,
      outputs: [stdout, stderr],
      parentProcessId: () => 1,
    });

    // Without a listener, emitting "error" throws; this is the uncaught EPIPE
    // that previously crashed the listener after its supervisor was killed.
    expect(() => stderr.emit("error", brokenPipe())).not.toThrow();
    expect(() => stdout.emit("error", brokenPipe())).not.toThrow();
    expect(onLost).toHaveBeenCalledOnce();
    expect(onLost).toHaveBeenCalledWith("diagnostic output reader closed");
    watch.close();
  });

  it("swallows other output errors without reporting supervisor loss", () => {
    const stderr = new EventEmitter();
    const onLost = vi.fn();
    const watch = watchRemoteListenerSupervisor({
      onLost,
      outputs: [stderr],
      parentProcessId: () => 1,
    });

    const error = new Error("write EIO") as NodeJS.ErrnoException;
    error.code = "EIO";
    expect(() => stderr.emit("error", error)).not.toThrow();
    expect(onLost).not.toHaveBeenCalled();
    watch.close();
  });

  it("stops reporting after close but keeps output errors handled", () => {
    vi.useFakeTimers();
    let parent = 99;
    const stderr = new EventEmitter();
    const onLost = vi.fn();
    const watch = watchRemoteListenerSupervisor({
      onLost,
      outputs: [stderr],
      parentProcessId: () => parent,
      intervalMs: 100,
    });

    watch.close();
    parent = 1;
    vi.advanceTimersByTime(1_000);
    expect(() => stderr.emit("error", brokenPipe())).not.toThrow();
    expect(onLost).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
