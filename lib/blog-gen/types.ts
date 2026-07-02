export interface BlogGenInput {
  keyword: string;
  target_audience?: string;
  business_context?: string;
  existing_url?: string;
  manual_eeat_notes?: string;
}

export interface Phase0Output {
  primary_intent: string;
  sub_intents: string[];
  scope_note: string;
  has_manual_eeat: boolean;
}

export interface SemanticCluster {
  cluster: string;
  terms: string[];
}

export interface Phase1Output {
  core_entities: string[];
  semantic_clusters: SemanticCluster[];
  notably_absent_from_competitors: string[];
}

export interface Phase2Output {
  fanout_queries: string[];
}

export interface CompetitorAngle {
  source: string;
  angle: string;
}

export interface Phase3Output {
  serp_patterns: {
    common_format: string;
    common_h1_pattern: string;
    avg_word_count: number;
  };
  ai_overview_summary: string;
  leading_angle_per_competitor: CompetitorAngle[];
  competitor_urls: string[];
}

export interface GapItem {
  topic: string;
  why_it_matters: string;
}

export interface Phase4Output {
  fully_covered: string[];
  partially_covered: string[];
  gaps: GapItem[];
}

export interface Phase5Output {
  differentiation_points: string[];
  angle_statement: string;
  target_word_count: number;
}

export interface OutlineSection {
  h2: string;
  must_answer: string;
  format: "prose" | "list" | "table" | "steps";
  needs_citation: boolean;
}

export interface SourceBriefItem {
  url: string;
  title: string;
  stat_or_finding: string;
  source_label: string;
  section_relevance: string;
}

export interface SourceBriefOutput {
  sources: SourceBriefItem[];
}

export interface Phase6Output {
  h1: string;
  sections: OutlineSection[];
}

export interface Phase7Output {
  draft_markdown: string;
  placeholders_needing_sources: string[];
  manual_eeat_used: boolean;
}

export interface SourcedClaim {
  claim: string;
  source_url: string;
  source_title: string;
  source_type: "gov" | "edu" | "institutional" | "news" | "industry_primary";
  supports_claim: boolean;
  author?: string;
  year?: string;
  publisher?: string;
}

export interface SuggestedImage {
  url: string;
  caption: string;
  attribution: string;
  harvard_ref: string;
  local_path?: string;
  place_after_section: string;
}

export interface Phase8Output {
  sourced_claims: SourcedClaim[];
  suggested_images: SuggestedImage[];
}

export interface CorrectionNeeded {
  location: string;
  issue: string;
  fix: string;
}

export interface Phase9Output {
  unresolved_claims: string[];
  corrections_needed: CorrectionNeeded[];
}

export interface Phase10Output {
  references_markdown: string;
  harvard_references: string[];
}

export interface Phase11Output {
  formatted_markdown: string;
}

export interface Phase12Output {
  eeat_notes: string[];
  adjustments_made: string[];
  manual_eeat_integrated: boolean | "n/a";
  revised_markdown: string;
}

export interface Phase115Output {
  pre_edit_signal_score: number;
  post_edit_signal_score: number;
  band: "Low" | "Moderate" | "High" | "Very high";
  categories_fixed: string[];
  revised_draft: string;
}

export interface Phase13Output {
  answer_first_every_section: boolean;
  avg_sentence_length_under_25_words: boolean;
  max_paragraph_sentences_5_or_under: boolean;
  flesch_kincaid_grade_approx_9: boolean;
  all_core_entities_present_and_contextualized: boolean;
  lists_used_where_structurally_needed: boolean;
  headings_are_query_shaped_and_seo_relevant: boolean;
  no_unsourced_stats_or_claims: boolean;
  no_fabricated_quotes_or_studies: boolean;
  hypotheticals_clearly_labeled_as_hypothetical: boolean;
  eeat_shown_not_just_claimed: boolean;
  every_reference_maps_to_a_used_claim: boolean;
  passages_are_self_contained_chunkable: boolean;
  information_gain_points_from_phase5_present: boolean;
  no_competitor_content_reproduced_verbatim: boolean;
  ai_signal_score_band_is_low: boolean;
  no_ai_vocabulary_cluster_of_3_or_more: boolean;
  no_challenges_closer_pattern: boolean;
  no_undue_significance_inflation_sentences: boolean;
  section_lengths_and_structure_vary_naturally: boolean;
  em_dash_density_under_1_per_200_words: boolean;
  failing_items: string[];
  gate_result: "PASS" | "FAIL";
}

export interface DocGapOutput {
  missing_sections: { h2: string; why_needed: string; suggested_content: string }[];
  weak_sections: { heading: string; current_issue: string; specific_fix: string }[];
  missing_entities: { entity: string; type: string; where_to_add: string }[];
  unsourced_claims: { claim: string; location: string; suggested_source_type: string }[];
  eeat_gaps: { signal: string; current: string; fix: string }[];
  structural_issues: { issue: string; location: string; fix: string }[];
  quick_wins: { title: string; description: string; impact: "high" | "medium" }[];
  overall_score: number;
  overall_verdict: string;
}

export interface BlogGenRun {
  run_id: string;
  keyword: string;
  status:
    | "RUNNING"
    | "STOPPED_AT_RESEARCH"
    | "STOPPED_AT_OUTLINE"
    | "STOPPED_AT_DRAFT"
    | "STOPPED_AT_FACTCHECK"
    | "STOPPED_AT_POLISH"
    | "STOPPED_AT_HUMANIZE"
    | "PASSED_QA_GATE"
    | "FAILED_QA_GATE"
    | "COMPLETE";
  created_at: string;
  updated_at: string;
  input: BlogGenInput;
  phases: {
    p0?: Phase0Output;
    p1?: Phase1Output;
    p2?: Phase2Output;
    p3?: Phase3Output;
    p4?: Phase4Output;
    p5?: Phase5Output;
    source_brief?: SourceBriefOutput;
    p6?: Phase6Output;
    p7?: Phase7Output;
    p8?: Phase8Output;
    p9?: Phase9Output;
    p10?: Phase10Output;
    p11?: Phase11Output;
    p12?: Phase12Output;
    p115?: Phase115Output;
    p13?: Phase13Output;
    doc_gap?: DocGapOutput;
  };
  final_markdown?: string;
  uploaded_article_text?: string;
  title?: string;
  meta_description?: string;
}
