// Result category selection — deterministic application logic, no AI involved.
//
// LOCKED CONTRACT (final — supersedes the brief "combine both" instruction
// from an earlier correction pass, which is now explicitly overridden):
// Dorar shows specialist and general results as SEPARATE categories on
// /hadith/search. They are never concatenated into one list. If the
// specialist tab has 1+ results, the specialist set is THE result set — full
// stop, general is not appended underneath it. Only when specialist is
// genuinely empty does general become the displayed set. This exactly
// mirrors both the original project spec and the independently-verified
// reference MCP tool (dorar-hadith-mcp:get_hadith_grading_consensus),
// cross-checked live: identical hadithIds, identical order.
//
// The non-selected category's data is NOT discarded — it's returned
// alongside the selected one so the UI can expose it separately (a toggle,
// not a merge) if it chooses to, per the "don't delete, don't concatenate"
// distinction in the locked spec.
//
// This module receives the ALREADY-PARSED { specialist, general } shape
// produced by the offscreen document — it does no DOM work and no network
// calls, only decides which already-retrieved category is primary.
export function selectResultCategory(parsed) {
  const specialistResults = parsed.specialist.results || [];
  const generalResults = parsed.general.results || [];
  const usingSpecialist = specialistResults.length > 0;

  return {
    category: usingSpecialist ? 'specialist' : 'general',
    results: usingSpecialist ? specialistResults : generalResults,
    resultsReportedCount: usingSpecialist ? parsed.specialist.count : parsed.general.count,
    resultsRetrievedCount: usingSpecialist ? specialistResults.length : generalResults.length,

    otherCategory: usingSpecialist ? 'general' : 'specialist',
    otherResults: usingSpecialist ? generalResults : specialistResults,
    otherReportedCount: usingSpecialist ? parsed.general.count : parsed.specialist.count,
    otherRetrievedCount: usingSpecialist ? generalResults.length : specialistResults.length,
  };
}
