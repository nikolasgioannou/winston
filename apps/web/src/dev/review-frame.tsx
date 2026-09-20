import { readReviewSelection } from "./review-registry";

export function ReviewFrame() {
  const { page, state } = readReviewSelection(window.location.search);

  if (!page || !state) {
    return (
      <p role="alert" className="p-6">
        This preview is unavailable.
      </p>
    );
  }

  const Preview = state.render;

  if (state.fullWidth) {
    return <Preview />;
  }

  return (
    <main className="p-5 md:p-10">
      <Preview />
    </main>
  );
}
