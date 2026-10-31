#pragma once
#include <string>

namespace shapes {

class Shape {
public:
    explicit Shape(std::string name);
    virtual ~Shape() = default;
    virtual double area() const = 0;
    std::string name() const { return name_; }

private:
    std::string name_;
};

class Circle : public Shape {
public:
    explicit Circle(double r);
    double area() const override;

private:
    double r_;
};

}  // namespace shapes
