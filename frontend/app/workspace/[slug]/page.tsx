'use client';

import { useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { workspaceAPI } from '@/app/lib/api';

/**
 * Redirect: /workspace/{slug} → /w/{shortId}
 * 
 * This preserves any old bookmarks or shared links that used the guessable slug URL.
 * The workspace API accepts both slug and short_id, so we fetch the workspace
 * to get its short_id, then redirect.
 */
export default function WorkspaceRedirect() {
  const router = useRouter();
  const params = useParams();
  const slug = params.slug as string;

  useEffect(() => {
    if (!slug) return;
    workspaceAPI.get(slug).then(res => {
      router.replace(`/w/${res.data.short_id}`);
    }).catch(() => {
      router.replace('/dashboard');
    });
  }, [slug, router]);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh', background: 'var(--color-bg-primary)',
      color: 'var(--color-text-primary)', fontFamily: 'var(--font-mono)',
    }}>
      Redirecting…
    </div>
  );
}
