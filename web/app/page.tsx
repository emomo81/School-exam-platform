export default function HomePage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "3rem", maxWidth: 640 }}>
      <h1 style={{ marginBottom: "0.25rem" }}>ExamPro</h1>
      <p style={{ color: "#555", marginTop: 0 }}>Secure. Fair. Transparent.</p>
      <p style={{ marginTop: "2rem" }}>
        Phase 0 skeleton is live. Frontend health:{" "}
        <a href="/api/health">/api/health</a>.
      </p>
    </main>
  );
}
