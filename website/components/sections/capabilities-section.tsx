const capabilities = [
  {
    number: "01",
    name: "Gameplay vision",
    detail:
      "Reads selected frames to identify the action on screen and the details that can support a call.",
    mark: "VISION",
  },
  {
    number: "02",
    name: "Match intelligence",
    detail:
      "Builds a structured picture of the match from validated observations and event evidence.",
    mark: "CONTEXT",
  },
  {
    number: "03",
    name: "Commentary generation",
    detail:
      "Turns supported moments into concise commentary, with evidence guiding what gets said.",
    mark: "ON AIR",
  },
  {
    number: "04",
    name: "Voice generation",
    detail:
      "A voice layer is part of the product direction, bringing generated commentary into the audio mix.",
    mark: "VOICE · IN DEVELOPMENT",
  },
  {
    number: "05",
    name: "Commentary Studio",
    detail:
      "A desktop workspace to bring in gameplay footage, run analysis, and inspect the results.",
    mark: "DESKTOP WORKSPACE",
  },
];

export default function CapabilitiesSection() {
  return (
    <section
      aria-labelledby="capabilities-title"
      id="capabilities"
      className="story-section capabilities-section scroll-mt-8"
    >
      <div className="section-shell scene-surface">
        <div className="section-heading-row">
          <div>
            <p className="section-index">What the engine is learning</p>
            <h2 id="capabilities-title" className="section-heading mt-5">
              From pixels to play-by-play.
            </h2>
          </div>
          <p className="body-copy max-w-sm">
            A set of connected capabilities, designed to keep every line close
            to what the match actually shows.
          </p>
        </div>

        <div className="capability-list">
          {capabilities.map((capability) => (
            <article className="capability-row" key={capability.number}>
              <span className="capability-number">{capability.number}</span>
              <h3>{capability.name}</h3>
              <p>{capability.detail}</p>
              <span className="capability-mark">{capability.mark}</span>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
