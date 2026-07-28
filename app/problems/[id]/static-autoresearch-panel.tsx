import styles from "./autoresearch-panel.module.css";

/** The Pages showcase must never load the local-only interactive panel. */
export function StaticAutoresearchPanel() {
  return (
    <section className={styles.panel} aria-label="Autoresearch preparation">
      <p>Available in local mode</p>
    </section>
  );
}
