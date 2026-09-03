package store

import "os"

// Test-only queries. Both were exported from the production build with no
// caller outside the tests (S6); they live here so the shipped binary carries
// only what it uses, and the tests keep the shapes they assert on.

// LatestForPath returns the newest version of one encrypted path, if any.
func (s *Store) LatestForPath(vaultID, path string) (Entry, bool, error) {
	return s.oneEntry(vaultID,
		`SELECT `+entryCols+` FROM entries WHERE vault_id = ? AND path = ?
		  ORDER BY uid DESC LIMIT 1`,
		vaultID, path)
}

// PrunedVault names a vault removed by PruneEmptyVaults.
type PrunedVault struct {
	VaultID   string
	CreatedAt int64
}

// PruneEmptyVaults removes vaults that hold no entries at all.
//
// These accumulate from typos in a vault id, from probing and from tests: a
// connect is enough to create the row, because EnsureVault runs before anything
// is pushed. They cost almost nothing, but they make the vault list untrustworthy
// as a picture of what is stored.
//
// minAgeMillis exists because "no entries" is also what a brand-new device looks
// like during its first connect, before its initial upload lands. Deleting the
// row underneath it would make the next AppendEntry fail with unknown vault.
//
// Only genuinely empty vaults qualify. A vault whose files were all deleted
// still has rows, because deletions are entries, so it is not empty and is not
// touched. That is rule 6, and it is the reason this is safe to run unattended.
func (s *Store) PruneEmptyVaults(now, minAgeMillis int64) ([]PrunedVault, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	rows, err := s.db.Query(
		`SELECT v.vault_id, v.created_at FROM vaults v
		  WHERE v.created_at <= ?
		    AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.vault_id = v.vault_id)`,
		now-minAgeMillis)
	if err != nil {
		return nil, err
	}
	var doomed []PrunedVault
	for rows.Next() {
		var pv PrunedVault
		if err := rows.Scan(&pv.VaultID, &pv.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		doomed = append(doomed, pv)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var pruned []PrunedVault
	for _, pv := range doomed {
		// The delete re-checks emptiness rather than trusting the list above.
		// Both run under one lock today; making the delete itself conditional
		// means a future caller that forgets the lock still cannot remove a
		// vault that has gained entries.
		res, err := s.db.Exec(
			`DELETE FROM vaults WHERE vault_id = ?
			   AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.vault_id = vaults.vault_id)`,
			pv.VaultID)
		if err != nil {
			return pruned, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			continue
		}
		pruned = append(pruned, pv)
		// The chunk directory should be absent or empty. Remove it only if
		// empty, so a surprise here leaves evidence instead of deleting data.
		dir := s.chunks.VaultDir(pv.VaultID)
		if entries, err := os.ReadDir(dir); err == nil && len(entries) == 0 {
			_ = os.Remove(dir)
		}
	}
	return pruned, nil
}
