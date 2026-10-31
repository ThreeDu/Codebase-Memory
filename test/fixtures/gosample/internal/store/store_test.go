package store

import "testing"

func TestNew(t *testing.T) {
	if New().Count() != 1 {
		t.Fatal("want 1")
	}
}
