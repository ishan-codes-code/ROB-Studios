export default function ProductIntroduction() {
  return (
    <section
      id="introduction"
      aria-labelledby="introduction-title"
      className="story-section introduction-section scroll-mt-8"
    >
      <div className="section-shell introduction-grid scene-surface">
        <p className="section-index">The signal in the spectacle</p>
        <div className="introduction-copy">
          <h2 id="introduction-title" className="display-heading">
            Gameplay is full of moments.
            <span className="text-white/45"> We give them meaning.</span>
          </h2>
          <p className="body-copy mt-8 max-w-xl">
            AI Commentator is being built to read the action, understand what
            matters, and turn the match into commentary with context.
          </p>
        </div>
        <div aria-hidden="true" className="intro-signal">
          <span className="intro-signal-core" />
          <span className="intro-signal-ring intro-signal-ring-one" />
          <span className="intro-signal-ring intro-signal-ring-two" />
          <span className="intro-signal-line" />
          <span className="intro-signal-label">A match, understood</span>
        </div>
      </div>
    </section>
  );
}
