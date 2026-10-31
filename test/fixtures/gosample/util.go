package main

type Label string

func greeting(n int) string {
	return "items: {" + itoa(n) + "}"
}

func itoa(n int) string { return string(rune('0' + n)) }
