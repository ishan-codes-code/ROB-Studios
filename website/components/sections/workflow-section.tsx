const stages = [
  "Gameplay footage",
  "Vision analysis",
  "Match understanding",
  "Commentary generation",
  "Voice output",
];

export default function WorkflowSection() {
  return (
    <section
      aria-labelledby="workflow-title"
      className="story-section workflow-section"
    >
      <div className="section-shell scene-surface">
        <div className="workflow-heading">
          <p className="section-index">A story, assembled</p>
          <h2 id="workflow-title" className="section-heading mt-5">
            One moment leads to the next.
          </h2>
        </div>

        <ol className="workflow-list">
          {stages.map((stage, index) => (
            <li className="workflow-stage" key={stage}>
              <span className="workflow-node" aria-hidden="true">
                <span />
              </span>
              <span className="workflow-step">0{index + 1}</span>
              <span className="workflow-name">{stage}</span>
              {index < stages.length - 1 && (
                <span className="workflow-connector" aria-hidden="true" />
              )}
            </li>
          ))}
        </ol>
        <p className="workflow-note">
          The Studio currently supports footage analysis and commentary
          workflows. Voice output is in development.
        </p>
      </div>
    </section>
  );
}
