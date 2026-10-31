using System.Linq;
using Shop.Models;

namespace Shop.Services;

public class OrderService
{
    private readonly List<Order> _orders = new() { new Order(2) };

    public OrderService() { }

    public int Total() => _orders.Sum(o => o.Qty);

    [Obsolete("use Total")]
    public async Task<int> TotalAsync()
    {
        return await Task.FromResult(Total());
    }
}
