/**
 * `browser snapshot` (docs/design.md §5 Browser): the page as a compact list
 * of what an agent can act on, each with a short ref (`e1`, `e2`, …), plus
 * the headings, landmarks and dialogs that say where things are. Built from
 * Chrome's accessibility tree (roles, names, values and states, in the shape
 * Playwright's ARIA snapshots and agent-browser use), not the DOM, so a
 * typical page is a few hundred tokens.
 *
 * Frames are spliced in where their `<iframe>` is: same-process frames
 * through the page's session, cross-site ones (their own renderer) through
 * the sessions auto-attach gives them. Shadow DOM is already in the tree.
 */
import type { Cdp } from "./cdp.ts";

interface AxValue {
  value?: unknown;
}

export interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: { name: string; value: AxValue }[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

/** One frame's tree, with its child frames by their `<iframe>`'s node. */
export interface AxFrame {
  sessionId: string;
  /** The frame's id (absent in recorded fixtures). */
  frameId?: string;
  /**
   * A cross-site frame's `<iframe>`, in its parent's session: its own
   * coordinates start there.
   */
  ownerInParent?: { sessionId: string; backendNodeId: number };
  nodes: AxNode[];
  /** Child frames, keyed by the owning `<iframe>`'s backend node id. */
  children: { owner: number; frame: AxFrame }[];
}

/** Where a ref points: a node in one frame's session. */
export interface RefTarget {
  sessionId: string;
  backendNodeId: number;
  frameId?: string | undefined;
  /** How the snapshot showed it: `button "Sign in"`. */
  label: string;
  /** For a cross-site frame, the `<iframe>` its coordinates are relative to. */
  offsetFrom?: { sessionId: string; backendNodeId: number } | undefined;
}

/** Elements an agent acts on: they get refs. */
const interactive = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "treeitem",
]);

/** Containers worth a line when they hold something kept. */
const containers = new Set([
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "search",
  "form",
  "dialog",
  "alertdialog",
  "group",
  "radiogroup",
  "tablist",
  "menu",
  "menubar",
  "listbox",
  "tree",
  "grid",
  "table",
  "region",
  "list",
]);

/** Containers that only count when they're named (they're everywhere otherwise). */
const namedOnly = new Set(["group", "region", "form"]);

/** Text whose words the element around it already says. */
const quietParents = new Set(["LabelText", "Legend", "heading"]);

const maxName = 80;
const maxText = 200;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
};

const str = (value: AxValue | undefined) =>
  typeof value?.value === "string" ? value.value : "";

function prop(node: AxNode, name: string) {
  return node.properties?.find((p) => p.name === name)?.value.value;
}

/** The states worth saying: what's on, off, open or unavailable. */
function states(node: AxNode) {
  const out: string[] = [];
  const checked = prop(node, "checked");
  if (checked === "true" || checked === true) out.push("checked");
  if (checked === "mixed") out.push("mixed");
  const pressed = prop(node, "pressed");
  if (pressed === "true" || pressed === true) out.push("pressed");
  if (prop(node, "selected") === true && str(node.role) !== "option")
    out.push("selected");
  const expanded = prop(node, "expanded");
  if (expanded === true) out.push("expanded");
  if (
    expanded === false &&
    prop(node, "hasPopup") !== "menu" &&
    str(node.role) !== "combobox"
  )
    out.push("collapsed");
  if (prop(node, "disabled") === true) out.push("disabled");
  if (prop(node, "readonly") === true) out.push("readonly");
  if (prop(node, "required") === true) out.push("required");
  if (prop(node, "invalid") === "true") out.push("invalid");
  if (prop(node, "focused") === true && str(node.role) !== "RootWebArea")
    out.push("focused");
  return out;
}

export interface SnapshotOptions {
  /** Include page text and images, not just what can be acted on. */
  full: boolean;
  /** Whether to give refs (not for a peek at another run's window). */
  refs: boolean;
  /** The ref for a node: the same one as last time if it's still there. */
  refFor: (target: RefTarget) => string;
}

export interface Snapshot {
  lines: string[];
  refs: Map<string, RefTarget>;
}

/** Renders frames as indented lines, assigning refs as it goes. */
export function formatSnapshot(
  root: AxFrame,
  options: SnapshotOptions,
): Snapshot {
  const refs = new Map<string, RefTarget>();

  function renderFrame(frame: AxFrame, depth: number): string[] {
    const byId = new Map(frame.nodes.map((node) => [node.nodeId, node]));
    const frameAt = new Map(frame.children.map((c) => [c.owner, c.frame]));
    const top = frame.nodes[0];
    if (!top) return [];

    const kids = (node: AxNode, at: number) =>
      (node.childIds ?? []).flatMap((id) => {
        const child = byId.get(id);
        return child ? render(child, at, node) : [];
      });

    function render(node: AxNode, at: number, parent?: AxNode): string[] {
      if (node.ignored) return kids(node, at);
      const role = str(node.role);
      const name = clip(str(node.name), maxName);
      const pad = "  ".repeat(at);
      const quoted = name ? ` "${name}"` : "";

      if (role === "InlineTextBox") return [];
      if (role === "Iframe") {
        const inner = node.backendDOMNodeId
          ? frameAt.get(node.backendDOMNodeId)
          : undefined;
        if (!inner) return [];
        const lines = renderFrame(inner, at + 1);
        return lines.length > 0 ? [`${pad}frame${quoted}`, ...lines] : [];
      }
      if (interactive.has(role) && node.backendDOMNodeId !== undefined) {
        // An option in a <select>'s popup is listed with its combobox.
        if (role === "option" && str(parent?.role) === "MenuListPopup")
          return [];
        const target = {
          sessionId: frame.sessionId,
          backendNodeId: node.backendDOMNodeId,
          frameId: frame.frameId,
          label: `${role}${quoted}`,
          offsetFrom: frame.ownerInParent,
        };
        let ref = "";
        if (options.refs) {
          ref = options.refFor(target);
          refs.set(ref, target);
        }
        const value = clip(str(node.value), maxName);
        const parts = [
          `${pad}${role}${quoted}`,
          ref ? `[${ref}]` : undefined,
          value && value !== name ? `= "${value}"` : undefined,
          ...states(node),
          role === "combobox" ? optionsOf(node) : undefined,
        ];
        const line = parts.filter(Boolean).join(" ");
        // Containers of their own items (a listbox's options) carry on down.
        return role === "combobox" && !optionsOf(node)
          ? [line, ...kids(node, at + 1)]
          : [line];
      }
      if (role === "heading") {
        const level = prop(node, "level");
        const line = `${pad}heading${quoted}${typeof level === "number" ? ` [h${String(level)}]` : ""}`;
        // Its text is its name; anything actionable in it (a link) follows.
        const inside = kids(node, at + 1);
        // A heading that's just a link (a search result) is one line.
        const only = inside.length === 1 ? inside[0]?.trimStart() : undefined;
        if (only?.startsWith(`link${quoted} `))
          return [`${pad}${only}${line.slice(line.lastIndexOf(" ["))}`];
        return name ? [line, ...inside] : inside;
      }
      if (containers.has(role) && (!namedOnly.has(role) || name)) {
        const inside = kids(node, at + 1);
        if (inside.length === 0) return [];
        const modal = prop(node, "modal") === true ? " (modal)" : "";
        return [`${pad}${role}${quoted}${modal}`, ...inside];
      }
      if (options.full) {
        if (
          role === "StaticText" &&
          /[\p{L}\p{N}]/u.test(name) &&
          !quietParents.has(str(parent?.role))
        )
          return [`${pad}text "${clip(str(node.name), maxText)}"`];
        if ((role === "image" || role === "img") && name)
          return [`${pad}img${quoted}`];
      }
      return kids(node, at);
    }

    /** A <select>'s options, inline: `(options: Canada, Cyprus)`. */
    function optionsOf(node: AxNode): string | undefined {
      const popup = (node.childIds ?? [])
        .map((id) => byId.get(id))
        .find((child) => str(child?.role) === "MenuListPopup");
      if (!popup) return undefined;
      const names: string[] = [];
      const collect = (at: AxNode) => {
        for (const id of at.childIds ?? []) {
          const child = byId.get(id);
          if (!child) continue;
          if (str(child.role) === "option")
            names.push(clip(str(child.name), 40));
          else collect(child);
        }
      };
      collect(popup);
      if (names.length === 0) return undefined;
      const shown = names.slice(0, 12).join(", ");
      return `(options: ${shown}${names.length > 12 ? `, … ${String(names.length - 12)} more` : ""})`;
    }

    // The root (RootWebArea) is the frame itself: render what's in it.
    return kids(top, depth);
  }

  return { lines: renderFrame(root, 0), refs };
}

/** Reads a page's accessibility tree, frames included, through CDP. */
export async function readFrames(
  c: Cdp,
  sessionId: string,
  /** Sessions of cross-site frames (auto-attached), by their target id. */
  childSessions: ReadonlyMap<string, string>,
): Promise<AxFrame> {
  const tree = async (session: string, frameId?: string) =>
    (
      await c.send<{ nodes: AxNode[] }>(
        "Accessibility.getFullAXTree",
        frameId ? { frameId } : {},
        session,
      )
    ).nodes;
  const owner = async (frameId: string) => {
    try {
      const result = await c.send<{ backendNodeId: number }>(
        "DOM.getFrameOwner",
        { frameId },
        sessionId,
      );
      return result.backendNodeId;
    } catch {
      return undefined;
    }
  };

  interface FrameTree {
    frame: { id: string };
    childFrames?: FrameTree[];
  }
  const { frameTree } = await c.send<{ frameTree: FrameTree }>(
    "Page.getFrameTree",
    {},
    sessionId,
  );

  async function build(node: FrameTree, isRoot: boolean): Promise<AxFrame> {
    const frame: AxFrame = {
      sessionId,
      frameId: node.frame.id,
      nodes: await tree(sessionId, isRoot ? undefined : node.frame.id),
      children: [],
    };
    for (const child of node.childFrames ?? []) {
      const at = await owner(child.frame.id);
      if (at !== undefined)
        frame.children.push({ owner: at, frame: await build(child, false) });
    }
    return frame;
  }

  const root = await build(frameTree, true);
  /** The frame holding a node: where a cross-site frame's <iframe> is. */
  const holding = (frame: AxFrame, node: number): AxFrame | undefined =>
    frame.nodes.some((n) => n.backendDOMNodeId === node)
      ? frame
      : frame.children
          .map((c) => holding(c.frame, node))
          .find((found) => found !== undefined);
  // Cross-site frames run in their own renderer, with their own session.
  for (const [targetId, childSession] of childSessions) {
    const at = await owner(targetId);
    if (at === undefined) continue;
    try {
      (holding(root, at) ?? root).children.push({
        owner: at,
        frame: {
          sessionId: childSession,
          // A cross-site frame's target id is its frame id.
          frameId: targetId,
          ownerInParent: { sessionId, backendNodeId: at },
          nodes: await tree(childSession),
          children: [],
        },
      });
    } catch {
      // The frame went away meanwhile.
    }
  }
  return root;
}
