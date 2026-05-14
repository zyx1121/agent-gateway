import { createServer, type Server, type Socket } from "node:net";
import { unlink } from "node:fs/promises";
import { chmod } from "node:fs/promises";

export interface Meta {
  [k: string]: string;
}

export interface Inbound {
  type: "inbound";
  content: string;
  meta: Meta;
}

export interface Hello {
  type: "hello";
  protocol: string;
  channel_version: string;
  pid: number;
}

export interface Reply {
  type: "reply";
  chat_id: string;
  text: string;
}

export interface Ack {
  type: "ack";
  for: "reply";
  ok: boolean;
  error?: string;
}

const MAX_LINE = 1 << 20; // 1 MiB
const BUFFER_LIMIT = 16;

export interface Handlers {
  onHello?: (hello: Hello) => void;
  onReply: (reply: Reply) => Promise<{ ok: boolean; error?: string }>;
  onDisconnect?: () => void;
}

export class DaemonSocket {
  private server: Server | null = null;
  private active: Socket | null = null;
  private buffered: Inbound[] = [];

  constructor(
    private readonly path: string,
    private readonly handlers: Handlers,
  ) {}

  async listen(): Promise<void> {
    await unlink(this.path).catch(() => {});
    this.server = createServer((sock) => this.onConnect(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.path, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    await chmod(this.path, 0o600).catch((err) => {
      console.warn(`[socket] chmod 0600 failed: ${err.message}`);
    });
    console.log(`[socket] listening on ${this.path}`);
  }

  async close(): Promise<void> {
    this.active?.destroy();
    this.active = null;
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    await unlink(this.path).catch(() => {});
  }

  private onConnect(sock: Socket): void {
    if (this.active) {
      console.warn("[socket] new channel connected, dropping previous");
      this.active.destroy();
    }
    this.active = sock;

    let buf = "";
    let helloSeen = false;

    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      if (buf.length > MAX_LINE && !buf.includes("\n")) {
        console.warn("[socket] line exceeds 1 MiB, dropping");
        buf = "";
        return;
      }
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line) continue;
        if (line.length > MAX_LINE) {
          console.warn("[socket] dropping oversized line");
          continue;
        }
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch (err) {
          console.warn(`[socket] bad json: ${err}`);
          continue;
        }
        if (!helloSeen) {
          if (msg.type !== "hello") {
            console.warn(`[socket] expected hello, got ${msg.type}, closing`);
            sock.destroy();
            return;
          }
          if (msg.protocol !== "v0") {
            console.warn(`[socket] unsupported protocol ${msg.protocol}, closing`);
            sock.destroy();
            return;
          }
          helloSeen = true;
          this.handlers.onHello?.(msg as Hello);
          this.flushBuffered();
          continue;
        }
        if (msg.type === "reply") {
          void this.handleReply(sock, msg as Reply);
        } else {
          console.warn(`[socket] unknown message type: ${msg.type}`);
        }
      }
    });

    const onEnd = (): void => {
      if (this.active === sock) {
        this.active = null;
        this.handlers.onDisconnect?.();
      }
    };
    sock.on("close", onEnd);
    sock.on("error", (err) => {
      console.warn(`[socket] connection error: ${err.message}`);
      onEnd();
    });
  }

  private async handleReply(sock: Socket, reply: Reply): Promise<void> {
    let ack: Ack;
    try {
      const res = await this.handlers.onReply(reply);
      ack = { type: "ack", for: "reply", ok: res.ok, error: res.error };
    } catch (err: any) {
      ack = { type: "ack", for: "reply", ok: false, error: String(err?.message ?? err) };
    }
    if (sock.writable) sock.write(JSON.stringify(ack) + "\n");
  }

  send(msg: Inbound): boolean {
    if (!this.active) {
      this.buffered.push(msg);
      while (this.buffered.length > BUFFER_LIMIT) {
        const dropped = this.buffered.shift();
        console.warn(
          `[socket] buffer full, dropping inbound chat=${dropped?.meta?.chat_id ?? "?"}`,
        );
      }
      return false;
    }
    this.active.write(JSON.stringify(msg) + "\n");
    return true;
  }

  private flushBuffered(): void {
    if (!this.active || this.buffered.length === 0) return;
    const queued = this.buffered;
    this.buffered = [];
    for (const m of queued) this.active.write(JSON.stringify(m) + "\n");
  }
}
