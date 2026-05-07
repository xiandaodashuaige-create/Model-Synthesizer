// D3 verification probe — pick a real multi-paper session, force a fresh
// landscape rebuild, and print the structured summary the Phase 1 review
// asked for. Read-only after the rebuild itself.
//
// Usage:  pnpm --filter @workspace/scripts run d3-probe -- <sessionId>
// Default sessionId is the largest one with hypotheses on it.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { rebuildLandscape } from "../../artifacts/api-server/src/lib/literature-landscape.js";

async function main(): Promise<void> {
  const argId = Number(process.argv[2]);
  let sessionId = Number.isFinite(argId) && argId > 0 ? argId : null;
  if (sessionId === null) {
    const top = await db.execute(sql`
      select s.id as id
      from sessions s
      where exists (select 1 from paper_hypotheses h where h.session_id = s.id)
      order by (select count(*) from paper_hypotheses h where h.session_id = s.id) desc
      limit 1
    `);
    sessionId = Number((top.rows[0] as { id: number }).id);
  }
  console.log(`\n[D3] probing session ${sessionId}\n`);

  const t0 = Date.now();
  const { rowsWritten, version } = await rebuildLandscape(sessionId);
  const ms = Date.now() - t0;
  console.log(`[rebuild] ${rowsWritten} rows written, landscapeVersion=${version}, took ${ms}ms\n`);

  // Pull the summary metrics.
  const summary = await db.execute(sql`
    with s as (select * from sessions where id = ${sessionId}),
         p as (select * from papers where session_id = ${sessionId} and external_id not like 'manual:%'),
         pall as (select * from papers where session_id = ${sessionId}),
         h as (select * from paper_hypotheses where session_id = ${sessionId}),
         cr as (select * from construct_relationships where session_id = ${sessionId})
    select
      (select count(*) from pall) as papers_all,
      (select count(*) from p) as papers_real,
      (select count(*) from p where extracted = 'true') as papers_extracted,
      (select count(*) from h) as hypotheses,
      (select count(*) from cr) as relationship_rows,
      (select count(*) from cr where sign_conflict = true) as sign_conflict_rows,
      (select count(*) from cr where relationship_type = 'direct') as direct_rows,
      (select count(*) from cr where relationship_type = 'moderation') as moderation_rows,
      (select count(*) from cr where relationship_type = 'mediation') as mediation_rows,
      (select max(total_occurrences) from cr) as max_occ,
      (select count(*) from cr where total_occurrences > (select count(*) from p)) as occ_overflow,
      (select count(*) from p where study_context is not null) as papers_with_study_context,
      (select count(*) from p where jsonb_array_length(coalesce(theory_backbone, '[]'::jsonb)) > 0) as papers_with_theory,
      (select count(*) from p where jsonb_array_length(coalesce(stated_gaps, '[]'::jsonb)) > 0) as papers_with_stated_gaps,
      (select landscape_meta from s) as landscape_meta
  `);
  const row = summary.rows[0] as Record<string, unknown>;
  console.log("== session summary ==");
  for (const [k, v] of Object.entries(row)) {
    if (k === "landscape_meta") continue;
    console.log(`  ${k.padEnd(28)} ${String(v)}`);
  }
  const meta = row.landscape_meta as Record<string, unknown> | null;
  if (meta) {
    const clusters = (meta.theoryClusters as Array<Record<string, unknown>>) ?? [];
    console.log(`  landscape_version           ${meta.landscapeVersion}`);
    console.log(`  last_rebuild_at             ${meta.lastRebuildAt}`);
    console.log(`  paperCount(meta)            ${meta.paperCount}`);
    console.log(`  hypothesisCount(meta)       ${meta.hypothesisCount}`);
    console.log(`  relationshipCount(meta)     ${meta.relationshipCount}`);
    console.log(`  theoryClusters              ${clusters.length} clusters`);
    for (const c of clusters.slice(0, 8)) {
      console.log(`    · ${String(c.label).padEnd(50)} papers=${c.paperCount}`);
    }
  }

  // Top relationships by paper count.
  const top = await db.execute(sql`
    select canonical_from, context_qualifier_from, canonical_to, context_qualifier_to,
           relationship_type, sign, sign_conflict, total_occurrences,
           earliest_year, latest_year, novelty_potential_score, domains_covered
    from construct_relationships
    where session_id = ${sessionId}
    order by total_occurrences desc, canonical_from
    limit 10
  `);
  console.log(`\n== top 10 relationships by paper count ==`);
  for (const r of top.rows as Array<Record<string, unknown>>) {
    const fromQ = r.context_qualifier_from ? `(${r.context_qualifier_from})` : "";
    const toQ = r.context_qualifier_to ? `(${r.context_qualifier_to})` : "";
    const conflict = r.sign_conflict ? " ⚠sign-conflict" : "";
    console.log(
      `  ${String(r.canonical_from)}${fromQ}  --[${r.relationship_type}/${r.sign}]-->  ${String(r.canonical_to)}${toQ}` +
      `   n=${r.total_occurrences}  ${r.earliest_year}-${r.latest_year}  novelty=${r.novelty_potential_score}${conflict}`,
    );
  }

  // Sample 3 supportingPapers entries to verify viaVariable / originalFrom / originalTo are present on moderation/mediation rows.
  const modSample = await db.execute(sql`
    select canonical_from, canonical_to, supporting_papers
    from construct_relationships
    where session_id = ${sessionId} and relationship_type in ('moderation','mediation')
    limit 3
  `);
  console.log(`\n== moderation/mediation supportingPapers structural metadata sample ==`);
  for (const r of modSample.rows as Array<Record<string, unknown>>) {
    const sp = (r.supporting_papers as Array<Record<string, unknown>>) ?? [];
    const first = sp[0] ?? {};
    console.log(`  ${r.canonical_from} → ${r.canonical_to}: viaVariable=${JSON.stringify(first.viaVariable)} originalFrom=${JSON.stringify(first.originalFrom)} originalTo=${JSON.stringify(first.originalTo)} (n=${sp.length})`);
  }

  // Sample 3 papers' new fields to verify D2-style field quality.
  const paperSample = await db.execute(sql`
    select id, external_id, year, study_context, theory_backbone, stated_gaps
    from papers
    where session_id = ${sessionId} and external_id not like 'manual:%'
    order by random()
    limit 3
  `);
  console.log(`\n== random 3 papers' Phase 1 new-field samples ==`);
  for (const r of paperSample.rows as Array<Record<string, unknown>>) {
    console.log(`  paper ${r.id} (${r.external_id}, ${r.year})`);
    console.log(`    studyContext:   ${JSON.stringify(r.study_context)}`);
    console.log(`    theoryBackbone: ${JSON.stringify(r.theory_backbone)?.slice(0, 220)}`);
    console.log(`    statedGaps:     ${JSON.stringify(r.stated_gaps)?.slice(0, 220)}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
