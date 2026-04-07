'use client';

import Script from 'next/script';
import CodexBridgeApp from '../components/CodexBridgeApp';

export default function Page() {
  return (
    <>
      <Script
        src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"
        strategy="afterInteractive"
        onLoad={() => {
          if (typeof window !== 'undefined' && window.marked) {
            window.marked.setOptions({ breaks: true, gfm: true });
            window.dispatchEvent(new Event('marked-ready'));
          }
        }}
      />
      <CodexBridgeApp />
    </>
  );
}
