const horizons = [
  {
    title: "Living commentary engine",
    description: "Commentary that can follow a match as it unfolds.",
  },
  {
    title: "Adaptive vision",
    description: "Sampling that adjusts to the pace and importance of play.",
  },
  {
    title: "Persistent match intelligence",
    description: "Context that carries forward across the full match.",
  },
  {
    title: "Live broadcast integration",
    description: "A path toward bringing commentary into live broadcasts.",
  },
];

export default function FutureSection() {
  return (
    <section id="roadmap" aria-labelledby="future-title" className="story-section future-section scroll-mt-8">
      <div className="section-shell future-layout scene-surface">
        <div className="future-intro">
          <p className="section-index">In development</p>
          <h2 id="future-title" className="section-heading mt-5">
            Built for the match ahead.
          </h2>
          <p className="body-copy mt-6 max-w-md">
            The long view is a commentary engine that stays with the game,
            learns its rhythm, and finds a place in the broadcast.
          </p>
        </div>

        <ul className="future-list">
          {horizons.map((horizon) => (
            <li className="future-item" key={horizon.title}>
              <span aria-hidden="true" className="future-marker" />
              <div>
                <h3>{horizon.title}</h3>
                <p>{horizon.description}</p>
              </div>
              <span className="future-status">Upcoming</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
