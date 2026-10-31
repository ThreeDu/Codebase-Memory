#include <iostream>
#include <memory>
#include "shapes/Shape.hpp"

int main() {
    auto c = std::make_unique<shapes::Circle>(2.0);
    std::cout << c->area() << std::endl;
}
