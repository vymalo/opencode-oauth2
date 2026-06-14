import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { saveSettings } from "../../shared/db";
import type { ExecutorMode } from "../../shared/types";
import { useSettings, useStatus } from "../../lib/hooks";
import { sendToBackground } from "../../lib/messaging";
import { timeAgo } from "../../lib/utils";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input, Label, Select } from "../ui/input";

export function ConnectionPanel() {
  const settings = useSettings();
  const status = useStatus();
  const [bridgeUrl, setBridgeUrl] = useState(settings.bridgeUrl);
  const [token, setToken] = useState(settings.token);
  const [executorMode, setExecutorMode] = useState<ExecutorMode>(settings.executorMode);
  const [label, setLabel] = useState(settings.label);

  // Re-seed when settings load or change out-of-band (only this panel writes them).
  useEffect(() => {
    setBridgeUrl(settings.bridgeUrl);
    setToken(settings.token);
    setExecutorMode(settings.executorMode);
    setLabel(settings.label);
  }, [settings]);

  const save = useMutation({
    mutationFn: async () => {
      await saveSettings({ bridgeUrl, token, executorMode, label });
      await sendToBackground({ type: "reconnect" });
    }
  });

  const online = status.state === "connected" || status.state === "connecting";

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Bridge connection</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="bridgeUrl">Bridge URL</Label>
            <Input
              id="bridgeUrl"
              value={bridgeUrl}
              onChange={(e) => setBridgeUrl(e.target.value)}
              placeholder="ws://127.0.0.1:4517"
              spellCheck={false}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="token">Token</Label>
            <Input
              id="token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="paste the token printed by the plugin"
              spellCheck={false}
            />
            <p className="text-xs opacity-60">
              The plugin logs <code>browser_bridge_token_generated</code> on first run — copy that
              value here. If you set <code>token</code> in the plugin options, use that instead.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="label">Browser label</Label>
            <Input
              id="label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. work-chrome (used as a routing target)"
              spellCheck={false}
            />
            <p className="text-xs opacity-60">
              Shown in <code>browser_targets</code> and usable as <code>target</code> when several
              browsers are connected. Defaults to a generated id.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="executor">Executor</Label>
            <Select
              id="executor"
              value={executorMode}
              onChange={(e) => setExecutorMode(e.target.value as ExecutorMode)}
            >
              <option value="auto">Auto (CDP on Chromium, else content-script)</option>
              <option value="cdp">CDP — trusted input, full-page capture (Chromium)</option>
              <option value="content">Content-script — no debugger banner (Firefox-safe)</option>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save & reconnect"}
            </Button>
            {online ? (
              <Button variant="outline" onClick={() => sendToBackground({ type: "disconnect" })}>
                Disconnect
              </Button>
            ) : null}
            {save.isSuccess ? <span className="text-xs text-success">Saved</span> : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <Row label="State" value={status.state} />
          <Row label="Executor" value={status.executor ?? "—"} />
          <Row label="Connected" value={status.connectedAt ? timeAgo(status.connectedAt) : "—"} />
          {status.lastError ? <Row label="Last error" value={status.lastError} danger /> : null}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="opacity-60">{label}</span>
      <span className={danger ? "text-right text-error" : "text-right"}>{value}</span>
    </div>
  );
}
