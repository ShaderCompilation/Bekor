import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createQueryClient, sessionQuery } from "./queries";
import { createAppRouter } from "./router";
import "./styles.css";

let signingOut = false;
const queryClient = createQueryClient(() => {
  // Several requests can fail at once; handle the first. Mark the user signed out without a
  // network call, let route guards redirect, then forget the previous user's private data.
  if (signingOut) return;
  signingOut = true;
  queryClient.setQueryData(sessionQuery.queryKey, null);
  void router.invalidate().finally(() => {
    queryClient.removeQueries({ queryKey: ["user"] });
    signingOut = false;
  });
});
const router = createAppRouter(queryClient);

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
