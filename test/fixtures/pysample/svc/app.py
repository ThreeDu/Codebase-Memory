from config import PORT
from models.churn import Model


def main():
    return Model().train()
