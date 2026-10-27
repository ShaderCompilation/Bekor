import type { Settings, TokenScope } from "@bekor/contracts";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { type FormEvent, useMemo, useState } from "react";
import { api } from "../api";
import { Badge, ErrorNotice } from "../components/ui";
import { formatDateTime } from "../format";
import { settingsQuery, tokensQuery } from "../queries";

const route = getRouteApi("/authed/settings");

export function SettingsPage() {
  return (
    <div className="page narrow">
      <h1>Settings</h1>
      <ReviewSettings />
      <CliTokens />
    </div>
  );
}

function ReviewSettings() {
  const { user } = route.useRouteContext();
  const queryClient = useQueryClient();
  const current = useSuspenseQuery(settingsQuery(user.id)).data;
  const [draft, setDraft] = useState<Settings>(current);
  const zones = useMemo(() => {
    const list = Intl.supportedValuesOf("timeZone");
    return list.includes(draft.timezone) ? list : [draft.timezone, ...list];
  }, [draft.timezone]);
  const update = useMutation({
    mutationFn: (input: Settings) => api.updateSettings(input),
    onSuccess: (saved) => {
      queryClient.setQueryData(settingsQuery(user.id).queryKey, saved);
      void queryClient.invalidateQueries({ queryKey: ["user", user.id, "reviews"] });
    },
  });
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate(draft);
  };
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <section>
      <h2>Reviews</h2>
      <form className="form" onSubmit={onSubmit}>
        <label>
          Timezone (decides when a review day starts)
          <select
            value={draft.timezone}
            onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
        {browserZone && browserZone !== draft.timezone && (
          <button
            type="button"
            className="link-button"
            onClick={() => setDraft({ ...draft, timezone: browserZone })}
          >
            Use this device's timezone ({browserZone})
          </button>
        )}
        <label>
          Daily review limit
          <input
            type="number"
            min={1}
            max={100}
            required
            value={draft.dailyReviewLimit}
            onChange={(event) =>
              setDraft({ ...draft, dailyReviewLimit: Number(event.target.value) })
            }
          />
        </label>
        {update.isError && <ErrorNotice error={update.error} />}
        {update.isSuccess && (
          <p className="muted" role="status">
            Saved.
          </p>
        )}
        <button type="submit" className="primary" disabled={update.isPending}>
          Save
        </button>
      </form>
    </section>
  );
}

const SCOPES: { scope: TokenScope; label: string }[] = [
  { scope: "submissions:read", label: "Read submissions" },
  { scope: "submissions:write", label: "Submit solutions" },
  { scope: "reviews:read", label: "Read reviews" },
  { scope: "reviews:write", label: "Start and complete reviews" },
];

function CliTokens() {
  const { user } = route.useRouteContext();
  const queryClient = useQueryClient();
  const tokens = useSuspenseQuery(tokensQuery(user.id)).data;
  const [name, setName] = useState("CLI");
  const [days, setDays] = useState(30);
  const [scopes, setScopes] = useState<TokenScope[]>(SCOPES.map((item) => item.scope));
  // The secret is shown once and kept only in component memory.
  const [secret, setSecret] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: tokensQuery(user.id).queryKey });
  const create = useMutation({
    mutationFn: () => api.createToken({ name: name.trim(), scopes, expiresInDays: days }),
    onSuccess: (data) => {
      setSecret(data.token);
      void refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeToken(id),
    onSuccess: refresh,
  });
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSecret(null);
    create.mutate();
  };
  const now = Date.now();

  return (
    <section>
      <h2>CLI tokens</h2>
      <p className="muted">
        Tokens let the <code>bekor</code> command-line tool act for you. Paste one into{" "}
        <code>bekor login</code>; never share it.
      </p>
      {secret && (
        <div className="notice notice-ok" role="status">
          <p>Copy this token now. It will not be shown again.</p>
          <div className="secret">
            <code>{secret}</code>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(secret)}>
              Copy
            </button>
          </div>
          <button type="button" className="link-button" onClick={() => setSecret(null)}>
            I saved it
          </button>
        </div>
      )}
      <form className="form" onSubmit={onSubmit}>
        <label>
          Name
          <input
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Expires in (days)
          <input
            type="number"
            min={1}
            max={90}
            required
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          />
        </label>
        <fieldset>
          <legend>Permissions</legend>
          {SCOPES.map((item) => (
            <label key={item.scope} className="checkbox">
              <input
                type="checkbox"
                checked={scopes.includes(item.scope)}
                onChange={(event) =>
                  setScopes(
                    event.target.checked
                      ? [...scopes, item.scope]
                      : scopes.filter((scope) => scope !== item.scope),
                  )
                }
              />
              {item.label}
            </label>
          ))}
        </fieldset>
        {create.isError && <ErrorNotice error={create.error} />}
        <button
          type="submit"
          className="primary"
          disabled={create.isPending || scopes.length === 0}
        >
          Create token
        </button>
      </form>

      {tokens.length > 0 && (
        <table className="history">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Expires</th>
              <th scope="col">Last used</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((token) => {
              const expired = Date.parse(token.expiresAt) <= now;
              const active = !token.revokedAt && !expired;
              return (
                <tr key={token.id}>
                  <td>
                    {token.name}
                    <div className="muted small">{token.scopes.join(", ")}</div>
                  </td>
                  <td>{formatDateTime(token.expiresAt)}</td>
                  <td>{token.lastUsedAt ? formatDateTime(token.lastUsedAt) : "never"}</td>
                  <td>
                    <Badge tone={active ? "ok" : "warn"}>
                      {token.revokedAt ? "revoked" : expired ? "expired" : "active"}
                    </Badge>
                  </td>
                  <td>
                    {active && (
                      <button
                        type="button"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Revoke "${token.name}"? The CLI using it stops working.`,
                            )
                          )
                            revoke.mutate(token.id);
                        }}
                        disabled={revoke.isPending}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {revoke.isError && <ErrorNotice error={revoke.error} />}
    </section>
  );
}
