import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  Combobox,
  Dialog,
  EmptyState,
  Menu,
  Notice,
  Select,
  Skeleton,
  Table,
  TextField,
  TextArea,
} from "@winston/ui";

const approvalOptions = [
  { value: "ask", label: "Ask before acting" },
  { value: "allow", label: "Allow actions" },
];

export function ComponentGallery({
  section = "controls",
}: {
  section?: "controls" | "feedback" | "layout";
}) {
  const [approval, setApproval] = useState<string | null>("ask");
  const [account, setAccount] = useState<string | null>("Personal · alex@example.com");
  const [notice, setNotice] = useState("");

  function resetPreferences() {
    setApproval("ask");
    setAccount("Personal · alex@example.com");
    setNotice("Preferences reset.");
  }

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">
          {section === "controls"
            ? "Controls"
            : section === "feedback"
              ? "Feedback"
              : "Data & layout"}
        </h1>
      </header>

      {section === "controls" && (
        <section id="controls" className="space-y-4" aria-label="Controls">
          <div className="grid items-start gap-5 lg:grid-cols-2">
            <Card
              title="Connected account"
              action={
                <Menu
                  label="Account options"
                  items={[
                    {
                      label: "Reset preferences",
                      onClick: resetPreferences,
                    },
                  ]}
                />
              }
            >
              <div className="space-y-5">
                <div>
                  <Combobox
                    label="Account"
                    items={["Personal · alex@example.com", "Work · alex@company.example"]}
                    value={account}
                    onValueChange={setAccount}
                  />
                </div>
                <div>
                  <Select
                    label="Approval policy"
                    options={approvalOptions}
                    value={approval}
                    onValueChange={setApproval}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
                  <Badge tone="success">Connected</Badge>
                  <Button
                    variant="primary"
                    onClick={() => {
                      setNotice("Saved.");
                    }}
                  >
                    Save preferences
                  </Button>
                </div>
              </div>
            </Card>
            <Card title="Fields & buttons">
              <div className="space-y-5">
                <TextField label="Computer name" defaultValue="Studio Mac" />
                <TextArea
                  label="Instruction"
                  rows={3}
                  defaultValue="Remind me to water the plants."
                />
                <TextField
                  label="Name with a validation error"
                  defaultValue=""
                  placeholder="Enter a name"
                  error="Give this computer a name before continuing."
                />
                <div className="flex flex-wrap gap-2">
                  <Button disabled>Unavailable</Button>
                  <Button variant="quiet" onClick={resetPreferences}>
                    Reset
                  </Button>
                </div>
              </div>
            </Card>
          </div>
          <p role="status" className="text-xs text-muted empty:hidden">
            {notice}
          </p>
        </section>
      )}

      {section === "feedback" && (
        <section id="feedback" className="space-y-4" aria-label="Feedback">
          <Notice title="Your computer is offline">
            Winston can use this computer when it’s awake and the proxy is connected.
          </Notice>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Empty state">
              <EmptyState
                title="No connected apps"
                action={
                  <Dialog trigger="Review connection" title="Connect an account">
                    <TextField label="Account label" defaultValue="Personal" />
                  </Dialog>
                }
              />
            </Card>
            <Card title="Status & loading">
              <div className="flex flex-wrap gap-5">
                <Badge tone="success">Connected</Badge>
                <Badge tone="warning">Needs attention</Badge>
                <Badge tone="error">Disconnected</Badge>
                <Badge>Pending</Badge>
              </div>
              <div className="mt-6 border-t border-line pt-4">
                <Skeleton label="Loading connected accounts" />
              </div>
            </Card>
          </div>
        </section>
      )}

      {section === "layout" && (
        <section id="layout" aria-label="Data and layout">
          <Card title="Computers">
            <Table
              caption="Example computers"
              columns={["Computer", "Status", "Access"]}
              rows={[
                {
                  id: "cloud",
                  cells: [
                    "Winston’s computer",
                    <Badge key="online" tone="success">
                      Online
                    </Badge>,
                    "Available",
                  ],
                },
                {
                  id: "mac",
                  cells: ["Studio Mac", <Badge key="offline">Offline</Badge>, "Ask before acting"],
                },
              ]}
            />
          </Card>
        </section>
      )}
    </div>
  );
}
