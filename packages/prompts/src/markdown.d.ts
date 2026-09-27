// Prompts are imported as text (`with { type: "text" }`), which Bun inlines.
declare module "*.md" {
  const content: string;
  export default content;
}
