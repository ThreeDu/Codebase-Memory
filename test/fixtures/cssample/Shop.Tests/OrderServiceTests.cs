using Shop.Services;
using Xunit;

namespace Shop.Tests;

public class OrderServiceTests
{
    [Fact]
    public void Totals() => Assert.Equal(2, new OrderService().Total());
}
