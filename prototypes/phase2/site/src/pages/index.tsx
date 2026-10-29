/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';

export default function Home(): ReactNode {
  return (
    <Layout title="Synthetic Docusaurus Site" description="Original fixtures for the DSH Live Editor tests.">
      <main style={{maxWidth: 760, margin: '4rem auto', padding: '0 1rem'}}>
        <h1>Synthetic Docusaurus Site</h1>
        <p>This site contains original fixtures used by the DSH Live Editor test suite.</p>
        <p><Link to="/docs/intro">Open the synthetic docs</Link></p>
      </main>
    </Layout>
  );
}
