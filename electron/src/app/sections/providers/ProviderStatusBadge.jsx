import { Badge } from "@/components/ui/badge.jsx";
import { credentialStatus, statusMeta } from "@/lib/provider-status.js";

/**
 * One status badge for a vault credential, shared by the providers
 * list, detail panel, settings overview, and editor Configure summary
 * so every surface describes the same record identically.
 */
export default function ProviderStatusBadge({ credential, connectedIds, failedIds }) {
  const status = credentialStatus(credential, { connectedIds, failedIds });
  const meta = statusMeta(status, credential?.purpose ?? "vision");
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}
