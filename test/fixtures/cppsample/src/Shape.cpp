#include "shapes/Shape.hpp"

namespace shapes {

Shape::Shape(std::string name) : name_(std::move(name)) {}

Circle::Circle(double r) : Shape("circle"), r_(r) {}

double Circle::area() const {
    return 3.14159 * r_ * r_;
}

}  // namespace shapes
