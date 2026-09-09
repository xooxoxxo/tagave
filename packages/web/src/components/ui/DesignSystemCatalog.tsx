import { useState } from 'react';
import { Button } from './Button';
import { TextField, Select, Textarea } from './FormControl';
import { Tabs } from './Tabs';
import { Badge } from './Badge';
import { Banner } from './Banner';
import { Card } from './Card';
import { Table, Th, Td } from './Table';
import { EmptyState } from './EmptyState';
import styles from './DesignSystemCatalog.module.css';
const surfaces = ['bg-primary', 'bg-secondary', 'bg-tertiary', 'surface-selected', 'surface-success', 'surface-warning', 'surface-danger', 'surface-info'];
/** Development-only HTML entry renders real components without auth or API fixtures. */
export function DesignSystemCatalog() {
  const [tab, setTab] = useState('controls');
  const [name, setName] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  return <main className={styles.catalog}>
    <header className={styles.header}><h1>tagave design system</h1><p>Shared foundations and working components, using the same code as the app.</p></header>
    <section className={styles.section} aria-labelledby="foundations"><h2 id="foundations">Foundations</h2><div className={styles.swatches}>{surfaces.map(token => <div key={token} className={styles.swatch}><span style={{ background: `var(--${token})` }} /><code>{token}</code></div>)}</div><p className={styles.note}>System sans · 12 / 14 / 16 / 18 / 20 / 32px · 4 / 8 / 12 / 16 / 24 / 32 / 48px spacing · 32 / 40px controls</p></section>
    <Tabs label="Component examples" panelId="catalog-panel" items={[{ value: 'controls', label: 'Controls' }, { value: 'data', label: 'Data display' }, { value: 'feedback', label: 'Feedback' }]} value={tab} onChange={setTab} />
    <div id="catalog-panel" role="tabpanel" aria-label={`${tab} examples`} className={styles.section}>
      {tab === 'controls' && <>
        <section><h2>Buttons</h2><div className={styles.row}><Button>Save changes</Button><Button variant="secondary">Cancel changes</Button><Button variant="ghost">Clear filters</Button><Button variant="danger">Delete example</Button><Button disabled>Unavailable</Button><Button size="sm" variant="secondary">Small control</Button></div><div className={styles.row}><Button loading={busy} onClick={() => setBusy(true)}>{busy ? 'Saving example…' : 'Try loading state'}</Button><Button variant="ghost" onClick={() => setBusy(false)}>Reset example</Button></div><p className={styles.note}>Buttons default to type="button". Use type="submit" for form submission. Loading disables repeat activation.</p></section>
        <section><h2>Forms</h2><form className={styles.form} onSubmit={event => { event.preventDefault(); setSubmitted(true); }} noValidate>
          <TextField label="Library name" required value={name} hint="A name that helps you recognize this library." error={submitted && !name.trim() ? 'Enter a library name.' : undefined} onChange={event => { setName(event.target.value); setSubmitted(false); }} />
          <TextField label="Disabled field" value="Read-only example" disabled />
          <label className={styles.label}>Default view<Select defaultValue="grid"><option value="grid">Album grid</option><option value="list">Album list</option></Select></label>
          <label className={styles.label}>Notes<Textarea placeholder="Add a note about your library" /></label>
          <Button type="submit">Validate example</Button>{submitted && name.trim() && <p role="status">Example is valid. Nothing was sent to a server.</p>}
        </form></section>
      </>}
      {tab === 'data' && <>
        <section><h2>Status labels</h2><div className={styles.row}><Badge>Draft</Badge><Badge tone="success">Applied</Badge><Badge tone="warning">Needs review</Badge><Badge tone="danger">Failed</Badge><Badge tone="info">Processing</Badge></div><p className={styles.note}>Status is always written in text. Badges are not buttons or navigation.</p></section>
        <section><h2>Tables</h2><Table><thead><tr><Th>Album</Th><Th>Artist</Th><Th>Status</Th></tr></thead><tbody><tr><Td>Example album</Td><Td>Example artist</Td><Td><Badge tone="success">Matched</Badge></Td></tr><tr><Td>Unidentified album</Td><Td>Unknown artist</Td><Td><Badge tone="warning">Needs review</Badge></Td></tr></tbody></Table></section>
        <Card title="Grouped content"><p>A card groups related information. Use page spacing and headings when a separate surface is unnecessary.</p></Card>
      </>}
      {tab === 'feedback' && <><h2>Messages</h2><Banner tone="success">Changes saved.</Banner><Banner tone="warning">Some files need review before changes can be applied.</Banner><Banner tone="danger">Couldn’t load this library. Try again.</Banner><Banner tone="info">Identification is running. Results appear as albums are processed.</Banner><EmptyState title="No albums match" text="Clear a filter or search for another artist." /></>}
    </div><footer className={styles.note}>Development catalog. See DESIGN.md for component contracts and migration rules.</footer>
  </main>;
}
