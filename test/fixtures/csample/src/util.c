#include "util.h"
#include <string.h>

static int helper(int x) { return x; }

int add(int a, int b)
{
    return helper(a) + b;
}

int twice(int x) {
    const char *s = "{";
    return add(x, x);
}
