import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { auth } from "../api";
import { ErrorNotice } from "../components/ui";
import { sessionQuery } from "../queries";
import { safeRedirect } from "../router";

const signInApi = getRouteApi("/sign-in");

function useAfterAuth(destination: string) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const navigate = useNavigate();
  return async () => {
    // A different account may have signed in on this tab; never reuse cached private data.
    queryClient.clear();
    await queryClient.fetchQuery(sessionQuery);
    await router.invalidate();
    await navigate({ to: safeRedirect(destination) });
  };
}

export function SignInPage() {
  const search = signInApi.useSearch();
  const afterAuth = useAfterAuth(search.redirect ?? "/");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const signIn = useMutation({
    mutationFn: () => auth.signIn(email.trim(), password),
    onSuccess: afterAuth,
  });
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    signIn.mutate();
  };
  return (
    <div className="auth-page">
      <h1>Sign in</h1>
      <form onSubmit={onSubmit} className="form">
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {signIn.isError && <ErrorNotice error={signIn.error} />}
        <button type="submit" className="primary" disabled={signIn.isPending}>
          {signIn.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="muted">
        No account? <Link to="/sign-up">Create one</Link> (private beta; registration may be
        closed).
      </p>
    </div>
  );
}

export function SignUpPage() {
  const afterAuth = useAfterAuth("/");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const signUp = useMutation({
    mutationFn: () => auth.signUp(name.trim(), email.trim(), password),
    onSuccess: afterAuth,
  });
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    signUp.mutate();
  };
  return (
    <div className="auth-page">
      <h1>Create account</h1>
      <form onSubmit={onSubmit} className="form">
        <label>
          Name
          <input
            autoComplete="name"
            required
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          Password <span className="muted">(at least 12 characters)</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {signUp.isError && <ErrorNotice error={signUp.error} />}
        <button type="submit" className="primary" disabled={signUp.isPending}>
          {signUp.isPending ? "Creating account…" : "Create account"}
        </button>
      </form>
      <p className="muted">
        Already registered? <Link to="/sign-in">Sign in</Link>
      </p>
    </div>
  );
}
