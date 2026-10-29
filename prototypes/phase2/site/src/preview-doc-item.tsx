/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import React from 'react';
import DocItem from '@theme/DocItem';

// Diagnostic-only wrapper for the live-preview docs instance. It deliberately
// reuses the official DocItem; it does not copy docs routes/sidebar/MDX code.
export default function PreviewDocItem(props: any): React.ReactNode {
  return <DocItem {...props} />;
}
