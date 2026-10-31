using Shop.Services;

namespace Shop
{
    public static class Program
    {
        public static void Main(string[] args)
        {
            var svc = new OrderService();
            System.Console.WriteLine(svc.Total());
        }
    }
}
