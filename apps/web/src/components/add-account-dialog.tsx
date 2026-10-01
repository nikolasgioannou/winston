import { Button, Dialog, IconTile, LinkCard, linkCardRow } from "@winston/ui";
import { ChevronRight } from "lucide-react";
import {
  connectableProviders,
  domainNames,
  ProviderIcon,
  providerNames,
} from "./providers";

/**
 * Add account: a dialog listing what can be connected, grouped by type,
 * each option starting its provider's connect flow.
 */
export function AddAccountDialog({ defaultOpen }: { defaultOpen?: boolean }) {
  return (
    <Dialog
      trigger={<Button>Add account</Button>}
      title="Add an account"
      {...(defaultOpen ? { defaultOpen } : {})}
    >
      {connectableProviders.map(({ domain, providers }) => (
        <section key={domain} className="flex flex-col gap-2">
          <h3 className="text-caption font-medium text-fg-muted">
            {domainNames[domain]}
          </h3>
          <LinkCard>
            {providers.map(({ provider, href }) => (
              // A full page load: connecting starts on the server.
              <a key={provider} href={href} className={linkCardRow}>
                <IconTile>
                  <ProviderIcon provider={provider} />
                </IconTile>
                <span className="flex-1 text-sm font-medium text-fg">
                  {providerNames[provider]}
                </span>
                <ChevronRight className="size-4 shrink-0 text-icon" />
              </a>
            ))}
          </LinkCard>
        </section>
      ))}
    </Dialog>
  );
}
