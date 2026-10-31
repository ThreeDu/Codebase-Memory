package store

import "github.com/google/uuid"

// Store keeps item ids.
type Store struct {
	items []string
}

func New() *Store {
	return &Store{items: []string{uuid.NewString()}}
}

func (s *Store) Count() int {
	return len(s.items)
}
